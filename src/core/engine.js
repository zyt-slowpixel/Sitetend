/**
 * Sitetend Core Engine - editing, versioning, per-operation undo/redo.
 *
 * Model (ARCHITECTURE §4):
 * - "Known" content K: the website content as Sitetend last saw/wrote it (persisted in .sitetend/known.json).
 * - External change: disk D differs from K. It is absorbed - diffed, logged in history (actor: external),
 *   and adopted as the new K. It never blocks Sitetend's own work on other fields.
 * - Apply = field-level three-way merge: each intended change (K_old → draft) is applied to D only if D still
 *   holds the old value there; if the field already has the new value it is skipped; otherwise it is a conflict.
 * - Undo/redo reverse Sitetend's own operations field by field (and asset by asset). A field changed by someone
 *   else since then is reported as a conflict instead of being overwritten. External changes are not on the undo
 *   stack (they appear in history only).
 * - Any one change in history (Sitetend's own or one made outside) can be taken back on its own (revertEntry), not
 *   only the latest via undo: its fields are set back to their earlier values as a new operation, so the revert itself
 *   can be undone. A field changed again since then is a conflict (nothing is changed). Replaced files are not reverted.
 * - Snapshots of the previous content are still written before every apply, for disaster recovery only.
 */

import {
  SUPPORTED_SCHEMA_VERSION,
  ERROR_CODES,
  createOk,
  createErr,
  validateSchemaVersion,
  computeContentHash,
  contentMatchesHash,
} from '../contracts.js';
import { createDefaultConfig, createDefaultState } from '../adapters/workspace-adapter.js';
import { sha256 } from '../agent/utils.js';

const UNDO_LIMIT = 100;
const SNAPSHOT_LIMIT = 30;     // full backups of the site text (disaster recovery only; undo keeps its own small records). Older ones are deleted.
const LOG_LIMIT = 500;
const PATHS = Object.freeze({
  WEBSITE_CONTENT: 'website/content.json',
  CONFIG: '.sitetend/config.json',
  STATE: '.sitetend/state.json',
  DRAFT: '.sitetend/drafts/draft.json',
  KNOWN: '.sitetend/known.json',
});
const snapPath = id => `.sitetend/snapshots/${id}.json`;
export const blobPath = hash => `.sitetend/blobs/${hash}.bin`;
const ASSET_PREFIX = 'asset:';
const newId = prefix => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const nowIso = () => new Date().toISOString();

export class SiteKeeperCore {
  constructor({ workspaceAdapter, siteAdapter }) {
    this.workspace = workspaceAdapter;
    this.siteAdapter = siteAdapter;
    this.config = null;
    this.state = null;
    this.liveContent = null;     // K: known content
    this.draftContent = null;
    this.draftBase = null;       // the content the current draft was derived from (intended changes = draftBase → draft)
    this.draftAssets = {};       // target path -> blob hash staged for the next Apply
    this.hasUnsavedDraft = false;
    this.externalPending = false; // disk differs from K and has not been absorbed (e.g. invalid JSON on disk)
    this.busy = false;
    this.scanLock = null;        // set by AnalysisEngine: () => true while a scan is running
  }

  /** Keeps a backup of a corrupt state.json, then lets the next initializeWorkspace() start fresh. */
  static async recoverCorruptState(workspace) {
    const raw = await workspace.readText(PATHS.STATE);
    if (raw.ok) {
      const backup = `.sitetend/state.corrupt-${Date.now()}.json`;
      const w = await workspace.writeText(backup, raw.data.content);
      if (!w.ok) return w;
      const del = await workspace.deleteFile(PATHS.STATE);
      if (!del.ok) return del;
      return createOk({ backupPath: backup });
    }
    return createOk({ backupPath: null });
  }

  // ------------------------------------------------------------------ website content on disk
  /** Reads the website's content. Single-file JSON sites read website/content.json; other adapters (HTML,
   *  Markdown/YAML/TOML sites) load their own files into one content object. Returns { ok, data: { data } }. */
  async _readLive() {
    return this.siteAdapter.readContent ? this.siteAdapter.readContent(this.workspace) : this.workspace.readJson(PATHS.WEBSITE_CONTENT);
  }
  /** Writes the website's content back (adapters with several files write only the files that changed). */
  async _writeLive(content) {
    return this.siteAdapter.writeContent ? this.siteAdapter.writeContent(this.workspace, content) : this.workspace.writeJson(PATHS.WEBSITE_CONTENT, content);
  }

  // ------------------------------------------------------------------ open
  async initializeWorkspace() {
    const liveRes = await this._readLive();
    if (!liveRes.ok) return liveRes;
    const contentValidation = this.siteAdapter.validateContent(liveRes.data.data);
    if (!contentValidation.ok) return contentValidation;
    const disk = liveRes.data.data;
    const diskHash = computeContentHash(disk);

    // Config
    const configExists = await this.workspace.exists(PATHS.CONFIG);
    if (!configExists.ok) return configExists;
    if (configExists.data.exists) {
      const cfgRes = await this.workspace.readJson(PATHS.CONFIG);
      if (!cfgRes.ok) return cfgRes;
      const verCheck = validateSchemaVersion(cfgRes.data.data, PATHS.CONFIG, SUPPORTED_SCHEMA_VERSION);
      if (!verCheck.ok) return verCheck;
      this.config = { ...createDefaultConfig(), ...cfgRes.data.data };
    } else {
      this.config = createDefaultConfig();
      const writeCfg = await this.workspace.writeJson(PATHS.CONFIG, this.config);
      if (!writeCfg.ok) return writeCfg;
    }

    // State
    let legacyBaseline = null;
    const stateExists = await this.workspace.exists(PATHS.STATE);
    if (!stateExists.ok) return stateExists;
    if (stateExists.data.exists) {
      const stRes = await this.workspace.readJson(PATHS.STATE);
      if (!stRes.ok) return { ...stRes, error: { ...stRes.error, details: { ...stRes.error.details, recoverableState: true } } };
      const verCheck = validateSchemaVersion(stRes.data.data, PATHS.STATE, SUPPORTED_SCHEMA_VERSION);
      if (!verCheck.ok) return verCheck;
      this.state = stRes.data.data;
      if (!Array.isArray(this.state.snapshots) || !Array.isArray(this.state.maintenanceLogs)) {
        return createErr(ERROR_CODES.INVALID_CONTENT_FORMAT, 'Core', 'The state record is damaged; no file was overwritten. Back it up and rebuild.', { recoverableState: true });
      }
      let dirty = false;
      if (!this.state.baselineContentHash) { this.state.baselineContentHash = diskHash; dirty = true; }
      if (this.state.baselineContentHash.startsWith('fnv1a_') && contentMatchesHash(disk, this.state.baselineContentHash)) {
        legacyBaseline = this.state.baselineContentHash; this.state.baselineContentHash = diskHash; dirty = true;
      }
      // Only per-operation entries are supported; older snapshot-based undo entries are dropped (no migration).
      for (const key of ['undoStack', 'redoStack']) {
        const list = Array.isArray(this.state[key]) ? this.state[key].filter(e => e && e.kind === 'ops') : [];
        if (!Array.isArray(this.state[key]) || list.length !== this.state[key].length) { this.state[key] = list; dirty = true; }
      }
      if (!this.state.assetBaseline || typeof this.state.assetBaseline !== 'object') { this.state.assetBaseline = {}; dirty = true; }
      if (dirty) await this.workspace.writeJson(PATHS.STATE, this.state);
    } else {
      this.state = { ...createDefaultState(diskHash), undoStack: [], redoStack: [], assetBaseline: {} };
      const writeSt = await this.workspace.writeJson(PATHS.STATE, this.state);
      if (!writeSt.ok) return writeSt;
    }

    // Known content K
    const known = await this.workspace.readJson(PATHS.KNOWN);
    if (known.ok && known.data.data?.hash === this.state.baselineContentHash && this.siteAdapter.validateContent(known.data.data.content).ok) {
      this.liveContent = known.data.data.content;
    } else {
      // First open (or legacy workspace): what is on disk now is the starting point.
      this.liveContent = disk;
      if (this.state.baselineContentHash !== diskHash) {
        this.state.baselineContentHash = diskHash;
        await this.workspace.writeJson(PATHS.STATE, this.state);
      }
      await this._writeKnown();
    }
    // Files the site's build now makes (build step turned on) are no longer content: drop them from K quietly,
    // so turning the build step on is not reported as a change made outside Sitetend.
    const ex = this.siteAdapter.exclude;
    if (ex?.size && this.liveContent?.files && Object.keys(this.liveContent.files).some(f => ex.has(f))) {
      this.liveContent = { ...this.liveContent, files: Object.fromEntries(Object.entries(this.liveContent.files).filter(([f]) => !ex.has(f))) };
      if (computeContentHash(this.liveContent) === diskHash && this.state.baselineContentHash !== diskHash) { this.state.baselineContentHash = diskHash; await this.workspace.writeJson(PATHS.STATE, this.state); }
      await this._writeKnown();
    }
    this.externalPending = computeContentHash(this.liveContent) !== diskHash;

    // Draft
    this.draftAssets = {};
    const draftExists = await this.workspace.exists(PATHS.DRAFT);
    if (!draftExists.ok) return draftExists;
    if (draftExists.data.exists) {
      const draftRes = await this.workspace.readJson(PATHS.DRAFT);
      if (!draftRes.ok) return draftRes;
      const env = draftRes.data.data;
      const verCheck = validateSchemaVersion(env, PATHS.DRAFT, SUPPORTED_SCHEMA_VERSION);
      if (!verCheck.ok) return verCheck;
      const draftContentValidation = this.siteAdapter.validateContent(env.content);
      if (!draftContentValidation.ok) return draftContentValidation;
      const basedOk = env.basedOnContentHash === this.state.baselineContentHash || (legacyBaseline && env.basedOnContentHash === legacyBaseline);
      if (!basedOk && computeContentHash(env.content) !== computeContentHash(this.liveContent)) {
        return createErr(ERROR_CODES.STALE_DRAFT_DETECTED, 'Core', 'The draft is based on an older version; the files were kept. Export or check the draft first.');
      }
      this.restoreContext = env.restoreContext || null;
      this.draftContent = env.content;
      this.draftBase = env.baseContent && this.siteAdapter.validateContent(env.baseContent).ok ? env.baseContent : structuredClone(this.liveContent);
      // A leftover draft whose changes are all already on the website (e.g. draft cleanup failed after a successful
      // apply) is clean, not "unsaved".
      const intended = this.siteAdapter.diffContent(this.draftBase, this.draftContent).data.changes;
      const done = intended.every(c => { const v = this.siteAdapter.getFieldValue(this.liveContent, c.path); return v.ok && same(v.data.value, c.after); });
      if (intended.length && done && !Object.keys(this.draftAssets).length) {
        this.draftContent = structuredClone(this.liveContent); this.draftBase = structuredClone(this.liveContent); this.restoreContext = null;
        await this.workspace.deleteFile(PATHS.DRAFT);
      }
      this.draftAssets = env.assets && typeof env.assets === 'object' ? env.assets : {};
    } else {
      this.draftContent = structuredClone(this.liveContent);
      this.draftBase = structuredClone(this.liveContent);
    }
    this.hasUnsavedDraft = this._hasPendingChanges();
    return createOk(this.getStatusSummary());
  }

  _hasPendingChanges() {
    const diffRes = this.siteAdapter.diffContent(this.draftBase || this.liveContent, this.draftContent);
    return (diffRes.ok ? diffRes.data.hasChanges : true) || Object.keys(this.draftAssets).length > 0;
  }

  async _writeKnown() {
    return this.workspace.writeJson(PATHS.KNOWN, { schemaVersion: SUPPORTED_SCHEMA_VERSION, hash: this.state.baselineContentHash, content: this.liveContent });
  }

  getStatusSummary() {
    const wsInfo = this.workspace.getWorkspaceInfo().data;
    const diff = this.siteAdapter.diffContent(this.draftBase || this.liveContent, this.draftContent).data;
    const editableFields = this.siteAdapter.listEditableFields(this.draftContent);
    const liveHash = computeContentHash(this.liveContent);
    const published = this.state?.published || null;
    const top = (this.state?.undoStack || []).at(-1);
    const pendingAssets = Object.keys(this.draftAssets);
    return {
      workspace: wsInfo,
      config: structuredClone(this.config),
      state: structuredClone(this.state),
      liveHash,
      baselineHash: this.state?.baselineContentHash || liveHash,
      externalEditDetected: this.externalPending,
      hasUnsavedDraft: diff.hasChanges || pendingAssets.length > 0,
      draftDiff: diff,
      pendingAssets,
      editableFields,
      lockedFields: [...(this.config?.lockedFields || [])],
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
      published,
      liveIsPublished: Boolean(published && published.hash === liveHash),
      undoLeavesPublished: Boolean(published && top && published.hash === liveHash),
      liveContent: structuredClone(this.liveContent),
      draftContent: structuredClone(this.draftContent),
    };
  }

  // ------------------------------------------------------------------ draft
  async _writeDraft(content, assets, extra = {}) {
    const envelope = { schemaVersion: SUPPORTED_SCHEMA_VERSION, basedOnContentHash: this.state.baselineContentHash, updatedAt: nowIso(),
      restoreContext: this.restoreContext || null, ...extra, assets, baseContent: this.draftBase || this.liveContent, content };
    const writeRes = await this.workspace.writeJson(PATHS.DRAFT, envelope);
    if (!writeRes.ok) return writeRes;
    this.draftContent = content;
    this.draftAssets = assets;
    this.hasUnsavedDraft = this._hasPendingChanges();
    return createOk(envelope);
  }

  async editDraftField(fieldPath, newValue) {
    const editRes = this.siteAdapter.setFieldValue(this.draftContent, fieldPath, newValue);
    if (!editRes.ok) return editRes;
    const w = await this._writeDraft(editRes.data.content, { ...this.draftAssets }, { lastEditedField: fieldPath });
    if (!w.ok) return w;
    return createOk({ updatedField: editRes.data.field, newValue: editRes.data.value, status: this.getStatusSummary() });
  }

  /** Replaces the whole draft (used when an item is added to or replaced in a list). */
  async setDraftContent(content, note = 'items') {
    const v = this.siteAdapter.validateContent(content); if (!v.ok) return v;
    const w = await this._writeDraft(content, { ...this.draftAssets }, { lastEditedField: note });
    if (!w.ok) return w;
    return createOk({ status: this.getStatusSummary() });
  }

  // ------------------------------------------------------------------ assets
  async storeBlob(bytes) {
    const hash = await sha256(bytes);
    const exists = await this.workspace.exists(blobPath(hash));
    if (!exists.ok) return exists;
    if (!exists.data.exists) {
      const w = await this.workspace.writeBytes(blobPath(hash), bytes);
      if (!w.ok) return w;
    }
    return createOk({ hash });
  }
  async _diskAssetHash(path) {
    const ex = await this.workspace.exists(path);
    if (!ex.ok || !ex.data.exists) return null;
    const r = await this.workspace.readBytes(path);
    if (!r.ok) throw Object.assign(Error(r.error.message), { code: r.error.code });
    return sha256(r.data.bytes);
  }
  async currentAssetHash(path) { try { return createOk({ hash: await this._diskAssetHash(path) }); } catch (e) { return createErr(e.code || ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', e.message); } }
  async stageAsset(targetPath, blobHash) {
    if (!this.siteAdapter.isFileWritable(targetPath) || targetPath === PATHS.WEBSITE_CONTENT) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'Core', `"${targetPath}" is outside the area Sitetend may write to.`, { targetPath }, false);
    }
    const ex = await this.workspace.exists(blobPath(blobHash));
    if (!ex.ok) return ex;
    if (!ex.data.exists) return createErr(ERROR_CODES.WORKSPACE_FILE_NOT_FOUND, 'Core', 'The file copy to write is missing. Check again.');
    return this._writeDraft(this.draftContent, { ...this.draftAssets, [targetPath]: blobHash });
  }
  async _writeAsset(path, hash) {
    if (hash === null) {
      const ex = await this.workspace.exists(path);
      return ex.ok && ex.data.exists ? this.workspace.deleteFile(path) : createOk({});
    }
    const blob = await this.workspace.readBytes(blobPath(hash));
    if (!blob.ok) return blob;
    return this.workspace.writeBytes(path, blob.data.bytes);
  }

  // ------------------------------------------------------------------ external changes
  /**
   * Adopts edits made outside Sitetend (Claude Code, an editor, a script) and records them in history.
   * Returns { absorbed: boolean, changes } - or an error if the file on disk is not valid content.
   */
  async absorbExternal({ disk: given, note = 'Changed outside Sitetend' } = {}) {
    let disk = given;
    if (!disk) {
      const r = await this._readLive();
      if (!r.ok) { this.externalPending = true; return r; }
      disk = r.data.data;
    }
    const valid = this.siteAdapter.validateContent(disk);
    if (!valid.ok) { this.externalPending = true; return valid; }
    const diskHash = computeContentHash(disk);
    const assetChanges = [];
    try {
      for (const [path, base] of Object.entries(this.state.assetBaseline || {})) {
        const cur = await this._diskAssetHash(path);
        if (cur !== base) assetChanges.push({ path, before: base, after: cur });
      }
    } catch (e) { return createErr(e.code || ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', e.message); }
    if (diskHash === this.state.baselineContentHash && !assetChanges.length) { this.externalPending = false; return createOk({ absorbed: false, changes: [] }); }

    const changes = this.siteAdapter.diffContent(this.liveContent, disk).data.changes;
    const next = structuredClone(this.state);
    next.baselineContentHash = diskHash;
    for (const a of assetChanges) { if (a.after) next.assetBaseline[a.path] = a.after; else delete next.assetBaseline[a.path]; }
    const assetLog = assetChanges.map(a => ({ path: ASSET_PREFIX + a.path, label: a.path, type: 'file', before: a.before, after: a.after, origin: 'external' }));
    if (changes.length || assetLog.length) {
      next.maintenanceLogs.unshift({ logId: newId('external'), timestamp: nowIso(), action: 'EXTERNAL_CHANGE', actor: 'external',
        note, changes: [...changes.map(c => ({ ...c, origin: 'external' })), ...assetLog],
        changedFields: [...changes.map(c => c.path), ...assetLog.map(c => c.path)], appliedHash: diskHash });
      next.maintenanceLogs = next.maintenanceLogs.slice(0, LOG_LIMIT);
    }
    const w = await this.workspace.writeJson(PATHS.STATE, next);
    if (!w.ok) return w;
    this.state = next;
    this.liveContent = disk;
    await this._writeKnown();
    // A draft without edits simply follows the new website content; a draft with edits keeps its own base,
    // so its intended changes (draftBase → draft) are merged field by field on the next apply.
    if (!this._hasPendingChanges()) { this.draftContent = structuredClone(disk); this.draftBase = structuredClone(disk); }
    this.externalPending = false;
    this.hasUnsavedDraft = this._hasPendingChanges();
    return createOk({ absorbed: true, changes: [...changes, ...assetLog] });
  }


  /**
   * Field-level three-way check. For each change {path, before, after}: apply if the target still holds `before`,
   * skip if it already holds `after`, otherwise report a conflict.
   */
  _merge(target, changes) {
    let out = target; const applied = [], conflicts = [], skipped = [];
    for (const c of changes) {
      const cur = this.siteAdapter.getFieldValue(out, c.path);
      const curVal = cur.ok ? cur.data.value : undefined;
      if (same(curVal, c.after)) { skipped.push(c); continue; }
      if (!same(curVal, c.before)) { conflicts.push({ path: c.path, before: c.before, after: c.after, current: curVal }); continue; }
      const r = this.siteAdapter.setFieldRaw(out, c.path, c.after);
      if (!r.ok) { conflicts.push({ path: c.path, before: c.before, after: c.after, current: curVal, error: r.error.message }); continue; }
      out = r.data.content; applied.push({ path: c.path, before: c.before, after: c.after, label: c.label, section: c.section, type: c.type });
    }
    return { content: out, applied, conflicts, skipped };
  }

  // ------------------------------------------------------------------ revert an external change
  /** History entries that can be taken back on their own. */
  static REVERTIBLE = new Set(['EXTERNAL_CHANGE', 'APPLY_DRAFT', 'RESTORE_VERSION', 'REVERT_EXTERNAL', 'REVERT_ENTRY']);
  /**
   * Sets the fields of one history entry back to their earlier values. The result is an ordinary operation: logged
   * (REVERT_EXTERNAL for a change made outside Sitetend, else REVERT_ENTRY), undoable. A field changed again since
   * then is a conflict, and then nothing is changed.
   */
  async revertExternal(logId) { return this.revertEntry(logId, { externalOnly: true }); }
  async revertEntry(logId, { externalOnly = false } = {}) {
    if (this.busy) return createErr('BUSY', 'Core', 'Another save is in progress.');
    const entry = (this.state.maintenanceLogs || []).find(l => l.logId === logId && (externalOnly ? l.action === 'EXTERNAL_CHANGE' : SiteKeeperCore.REVERTIBLE.has(l.action)));
    if (!entry) return createErr(ERROR_CODES.WORKSPACE_FILE_NOT_FOUND, 'Core', 'This history entry cannot be reverted.');
    const fields = (entry.changes || []).filter(c => !String(c.path).startsWith(ASSET_PREFIX));
    if (!fields.length) return createErr('NOT_REVERTIBLE', 'Core', 'Only files were replaced here; they cannot be reverted on their own.');
    if (this._hasPendingChanges()) return createErr(ERROR_CODES.STALE_DRAFT_DETECTED, 'Core', 'There are draft changes not written yet. Apply or discard them first, then revert.');
    const ab = await this.absorbExternal(); if (!ab.ok) return ab;
    const back = fields.map(c => ({ path: c.path, before: c.after, after: c.before, label: c.label, section: c.section, type: c.type }));
    const merge = this._merge(this.liveContent, back);
    if (merge.conflicts.length) return createErr('REVERT_CONFLICT', 'Core', 'Changed again since then: ' + merge.conflicts.map(c => c.path).join(', '), { conflicts: merge.conflicts });
    if (!merge.applied.length) return createErr('ALREADY_REVERTED', 'Core', 'This change has already been reverted.');
    this.draftBase = structuredClone(this.liveContent);
    this.draftContent = merge.content;
    this.revertContext = { logId, external: entry.action === 'EXTERNAL_CHANGE' };
    this.busy = true;
    try { return await this._applyDraft({ note: entry.action === 'EXTERNAL_CHANGE' ? 'Reverted a change made outside Sitetend' : 'Reverted an earlier change' }); }
    catch (e) { return createErr(e.code || ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', e.message); }
    finally { this.busy = false; if (this.revertContext) { this.revertContext = null; this.draftContent = structuredClone(this.liveContent); this.draftBase = structuredClone(this.liveContent); } }
  }

  // ------------------------------------------------------------------ adopt disk (kept for compatibility)
  async discardDraft() {
    const ab = await this.absorbExternal();
    if (!ab.ok) return ab;
    // Undo steps that can no longer be reversed (their fields were changed elsewhere) would block every older
    // step. "Use the current files" drops them from the top of the stack, and says so in history.
    const dropped = [];
    while ((this.state.undoStack || []).length) {
      const top = this.state.undoStack.at(-1);
      const back = top.changes.map(c => ({ path: c.path, before: c.after, after: c.before }));
      if (!this._merge(this.liveContent, back).conflicts.length) break;
      dropped.push(this.state.undoStack.pop());
    }
    if (dropped.length) {
      const next = structuredClone(this.state);
      next.redoStack = [];
      next.maintenanceLogs.unshift({ logId: newId('adopt'), timestamp: nowIso(), action: 'ADOPT_DISK', note: 'Kept the current files; dropped undo steps that were overwritten elsewhere',
        droppedSteps: dropped.length, changes: [], changedFields: [] });
      const w = await this.workspace.writeJson(PATHS.STATE, next);
      if (!w.ok) return w;
      this.state = next;
    }
    const del = await this.workspace.deleteFile(PATHS.DRAFT);
    if (!del.ok) return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', 'The draft could not be deleted. Check permissions and try again.');
    this.draftContent = structuredClone(this.liveContent);
    this.draftBase = structuredClone(this.liveContent);
    this.draftAssets = {};
    this.restoreContext = null;
    this.hasUnsavedDraft = false;
    return createOk(this.getStatusSummary());
  }

  // ------------------------------------------------------------------ apply
  /**
   * A write that was cut off last time (power loss, a forced quit): changes the owner had accepted were in the draft,
   * the website files were written only partly (or not at all), and the history was not saved. Finished here, as one
   * history entry that can be undone. Only when every file that differs from the recorded website is exactly the
   * draft's version of it: any other difference (an edit made meanwhile) is left to the usual conflict handling.
   */
  async finishInterruptedApply() {
    if (!this.hasUnsavedDraft || this.restoreContext || this.revertContext) return createOk({ finished: false });
    const diskRes = await this._readLive(); if (!diskRes.ok) return diskRes;
    const disk = diskRes.data.data, live = this.liveContent, draft = this.draftContent;
    const partOfDraft = (() => {
      if (live?.files && disk?.files && draft?.files) {
        const names = new Set([...Object.keys(live.files), ...Object.keys(disk.files)]);
        for (const f of names) if (disk.files[f] !== live.files[f] && disk.files[f] !== draft.files[f]) return false;
        return true;
      }
      const d = computeContentHash(disk); return d === computeContentHash(live) || d === computeContentHash(draft);
    })();
    if (!partOfDraft) return createOk({ finished: false });
    if (computeContentHash(disk) !== computeContentHash(live)) {   // put the half-written part back, then write everything once
      const w = await this._writeLive(live); if (!w.ok) return w;
    }
    const r = await this._applyDraft({ note: 'Finished a change that was cut off' });
    return r.ok ? createOk({ finished: true, result: r.data }) : r;
  }

  async applyDraftToWorkspace(options = {}) {
    if (this.busy) return createErr('BUSY', 'Core', 'Another save is in progress.');
    if (this.scanLock?.()) return createErr('BUSY', 'Core', 'A check is running. Wait for it to finish, then apply.');
    this.busy = true;
    try { return await this._applyDraft(options); }
    catch (e) { return createErr(e.code || ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', e.message); }
    finally { this.busy = false; }
  }

  async _applyDraft({ note = 'Manual edit' } = {}) {
    if (!(this.siteAdapter.canWriteContent ? this.siteAdapter.canWriteContent() : this.siteAdapter.isFileWritable(PATHS.WEBSITE_CONTENT))) {
      return createErr(ERROR_CODES.PATH_OUT_OF_SCOPE, 'Core', `"${PATHS.WEBSITE_CONTENT}" is outside the area the adapter may write to.`, {}, false);
    }
    const diskRes = await this._readLive();
    if (!diskRes.ok) return diskRes;
    const diskCheck = this.siteAdapter.validateContent(diskRes.data.data);
    if (!diskCheck.ok) return diskCheck;
    const disk = diskRes.data.data;
    const diskHash = computeContentHash(disk);

    // What the user/agent intends: K (as the draft was based on it) → draft.
    const intended = this.siteAdapter.diffContent(this.draftBase || this.liveContent, this.draftContent).data.changes;
    // Absorb outside edits first (logged separately; not undone by our undo).
    if (diskHash !== this.state.baselineContentHash) { const ab = await this.absorbExternal({ disk }); if (!ab.ok) return ab; }

    const merge = this._merge(disk, intended);
    if (merge.conflicts.length) {
      return createErr(ERROR_CODES.BASELINE_CONFLICT_DETECTED, 'Core', 'These places were changed outside Sitetend, so they were not overwritten: ' + merge.conflicts.map(c => c.path).join(', '),
        { conflicts: merge.conflicts }, true);
    }

    const assetChanges = [];
    for (const [path, hash] of Object.entries(this.draftAssets)) {
      const cur = await this._diskAssetHash(path);
      const base = this.state.assetBaseline?.[path];
      if (base !== undefined && cur !== base) return createErr(ERROR_CODES.BASELINE_CONFLICT_DETECTED, 'Core', `${path} was changed outside Sitetend, so it was not overwritten.`, { path });
      if (cur !== hash) assetChanges.push({ path, before: cur, after: hash });
    }
    if (!merge.applied.length && !assetChanges.length) {
      this.draftContent = structuredClone(this.liveContent); this.draftBase = structuredClone(this.liveContent); this.draftAssets = {};
      await this.workspace.deleteFile(PATHS.DRAFT); this.hasUnsavedDraft = false;
      return createOk({ snapshotId: null, appliedChanges: [], status: this.getStatusSummary() });
    }
    const newContent = merge.content;
    const valid = this.siteAdapter.validateContent(newContent);
    if (!valid.ok) return valid;

    if (this.beforeApply) { const guard = await this.beforeApply(); if (!guard.ok) return guard; }

    // Backups: content snapshot + replaced asset blobs (disaster recovery only).
    for (const c of assetChanges) {
      if (c.before) { const old = await this.workspace.readBytes(c.path); if (!old.ok) return old; const st = await this.storeBlob(old.data.bytes); if (!st.ok) return st; }
    }
    const snapshotId = newId('snap');
    const snapWrite = await this.workspace.writeJson(snapPath(snapshotId), { schemaVersion: SUPPORTED_SCHEMA_VERSION, snapshotId, createdAt: nowIso(),
      previousContentHash: diskHash, note: `Backup before: ${note}`, content: disk, assets: Object.fromEntries(assetChanges.map(c => [c.path, c.before])),
      sourceBaseline: structuredClone(this.state.sourceBaseline || this.historySourceBaseline || {}) });
    if (!snapWrite.ok) return snapWrite;

    const recheck = await this._readLive();
    if (!recheck.ok) return recheck;
    if (computeContentHash(recheck.data.data) !== diskHash) return createErr(ERROR_CODES.STALE_DRAFT_DETECTED, 'Core', 'The website changed again during the backup; nothing was applied.');
    if (this.beforeApply) { const guard = await this.beforeApply(); if (!guard.ok) return guard; }

    const newHash = computeContentHash(newContent);
    const rollback = async () => {
      let ok = true;
      const latest = await this._readLive();
      if (latest.ok && computeContentHash(latest.data.data) === newHash) ok = (await this._writeLive(disk)).ok && ok;
      for (const c of assetChanges) ok = (await this._writeAsset(c.path, c.before)).ok && ok;
      return ok;
    };
    if (merge.applied.length) { const w = await this._writeLive(newContent); if (!w.ok) return w; }
    for (const c of assetChanges) {
      const w = await this._writeAsset(c.path, c.after);
      if (!w.ok) { await rollback(); return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', `${c.path} could not be written; Sitetend tried to restore it.`); }
    }

    const next = structuredClone(this.state);
    const beforeSourceBaseline = structuredClone(next.sourceBaseline || null);
    next.baselineContentHash = newHash;
    if (this.pendingSourceBaseline) next.sourceBaseline = structuredClone(this.pendingSourceBaseline);
    next.lastAppliedAt = nowIso();
    next.assetBaseline = { ...(next.assetBaseline || {}) };
    for (const c of assetChanges) next.assetBaseline[c.path] = c.after;
    next.snapshots.unshift({ snapshotId, path: snapPath(snapshotId), createdAt: next.lastAppliedAt, contentHash: diskHash,
      changedFieldsCount: merge.applied.length + assetChanges.length, note, assets: assetChanges.map(c => c.before).filter(Boolean) });
    next.snapshots = next.snapshots.slice(0, SNAPSHOT_LIMIT);
    next.undoStack = [...(next.undoStack || []), { kind: 'ops', id: snapshotId, note, at: next.lastAppliedAt,
      changes: merge.applied.map(({ path, before, after }) => ({ path, before, after })), assets: assetChanges,
      beforeSourceBaseline, afterSourceBaseline: structuredClone(next.sourceBaseline || null) }].slice(-UNDO_LIMIT);
    next.redoStack = [];
    const assetLog = assetChanges.map(c => ({ path: ASSET_PREFIX + c.path, label: c.path, type: 'file', before: c.before, after: c.after,
      ...(this.describeChange?.(ASSET_PREFIX + c.path) || { origin: 'manual' }) }));
    const reverting = this.revertContext?.logId || null;
    next.maintenanceLogs.unshift({ logId: snapshotId, timestamp: nowIso(), action: reverting ? (this.revertContext.external ? 'REVERT_EXTERNAL' : 'REVERT_ENTRY') : this.restoreContext ? 'RESTORE_VERSION' : 'APPLY_DRAFT', note,
      restoredFromSnapshot: this.restoreContext?.snapshotId || null, ...(reverting ? { reverts: reverting } : {}),
      changes: [...merge.applied.map(c => ({ ...c, ...(reverting ? { origin: 'revert' } : this.describeChange?.(c.path) || { origin: this.restoreContext ? 'restore' : 'manual' }) })), ...assetLog],
      previousHash: diskHash, appliedHash: newHash, changedFields: [...merge.applied.map(c => c.path), ...assetLog.map(c => c.path)] });
    next.maintenanceLogs = next.maintenanceLogs.slice(0, LOG_LIMIT);
    const stateWrite = await this.workspace.writeJson(PATHS.STATE, next);
    if (!stateWrite.ok) {
      const ok = await rollback();
      return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', ok ? 'The history could not be saved; the website was restored and the draft and backup kept. Try again.' : 'Saving partly failed: the website may have changed. The draft and backup are kept; reload to check.',
        { partialWrite: !ok, snapshotPath: snapPath(snapshotId), cause: stateWrite.error });
    }
    const prev = this.state;
    this.state = next;
    this.pendingSourceBaseline = null;
    this.liveContent = newContent;
    this.draftContent = structuredClone(newContent);
    this.draftBase = structuredClone(newContent);
    this.restoreContext = null; this.revertContext = null;
    this.draftAssets = {};
    await this._writeKnown();
    const cleanup = await this.workspace.deleteFile(PATHS.DRAFT);
    this.hasUnsavedDraft = false;
    await this._gc(prev, next);
    return createOk({ warning: cleanup.ok ? null : 'The website and history were saved, but the draft could not be cleaned up.', snapshotId,
      appliedChanges: [...merge.applied, ...assetLog], skipped: merge.skipped.map(c => c.path), status: this.getStatusSummary() });
  }

  /** Deletes snapshot and blob files the previous state referenced but the next state no longer does. */
  async _gc(prev, next) {
    const refs = s => {
      const files = new Set(), blobs = new Set();
      for (const x of s?.snapshots || []) { files.add(x.path); for (const b of x.assets || []) blobs.add(b); }
      for (const e of [...(s?.undoStack || []), ...(s?.redoStack || [])]) for (const a of e.assets || []) { if (a.before) blobs.add(a.before); if (a.after) blobs.add(a.after); }
      for (const h of Object.values(s?.assetBaseline || {})) if (h) blobs.add(h);
      return { files, blobs };
    };
    const a = refs(prev), b = refs(next);
    const keep = new Set([...b.blobs, ...Object.values(this.draftAssets)]);
    for (const f of a.files) if (!b.files.has(f)) await this.workspace.deleteFile(f);
    for (const h of a.blobs) if (!keep.has(h)) await this.workspace.deleteFile(blobPath(h));
  }

  // ------------------------------------------------------------------ settings
  get autoApply() { return this.config?.autoApply !== false; }
  async _saveConfig(next) {
    const w = await this.workspace.writeJson(PATHS.CONFIG, next);
    if (!w.ok) return w;
    this.config = next;
    return createOk(structuredClone(next));
  }
  async setAutoApply(enabled) { const r = await this._saveConfig({ ...this.config, autoApply: Boolean(enabled) }); return r.ok ? createOk({ autoApply: this.autoApply }) : r; }
  isFieldLocked(fieldPath) { return (this.config?.lockedFields || []).includes(fieldPath); }
  async setFieldLock(fieldPath, locked) {
    const known = this.siteAdapter.listEditableFields(this.draftContent).some(f => f.path === fieldPath) || fieldPath.startsWith(ASSET_PREFIX);
    if (!known) return createErr(ERROR_CODES.FIELD_NOT_EDITABLE, 'Core', `There is no field "${fieldPath}".`);
    const set = new Set(this.config.lockedFields || []);
    if (locked) set.add(fieldPath); else set.delete(fieldPath);
    const r = await this._saveConfig({ ...this.config, lockedFields: [...set].sort() });
    return r.ok ? createOk({ lockedFields: r.data.lockedFields }) : r;
  }
  async applyIfAuto(options = {}) {
    if (!this.autoApply) return createOk({ applied: false });
    const r = await this.applyDraftToWorkspace(options);
    return r.ok ? createOk({ applied: true, ...r.data }) : r;
  }
  async markPublished({ publishedHash, publisherId, publishedAt, url = null, detail = null }) {
    if (publishedHash !== this.state.baselineContentHash) return createErr(ERROR_CODES.PUBLISH_FAILED, 'Core', 'The published version differs from the current local version; not recorded.');
    const next = structuredClone(this.state);
    next.published = { hash: publishedHash, publisherId, at: publishedAt || nowIso(), url };
    next.maintenanceLogs.unshift({ logId: newId('publish'), timestamp: next.published.at, action: 'PUBLISH', note: `Published (${publisherId})`,
      detail, changes: [], changedFields: [], appliedHash: publishedHash });
    const w = await this.workspace.writeJson(PATHS.STATE, next);
    if (!w.ok) return w;
    this.state = next;
    return createOk(this.getStatusSummary());
  }

  // ------------------------------------------------------------------ undo / redo (per operation)
  canUndo() { return (this.state?.undoStack || []).length > 0; }
  canRedo() { return (this.state?.redoStack || []).length > 0; }
  async undo() { return this._guardedStep('undo'); }
  async redo() { return this._guardedStep('redo'); }
  async _guardedStep(direction) {
    if (this.busy) return createErr('BUSY', 'Core', 'Another save is in progress.');
    if (this.scanLock?.()) return createErr('BUSY', 'Core', 'A check is running; undo or redo in a moment.');
    this.busy = true;
    try { return await this._step(direction); }
    catch (e) { return createErr(e.code || ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', e.message); }
    finally { this.busy = false; }
  }

  async _step(direction) {
    const undoing = direction === 'undo';
    const stack = (undoing ? this.state.undoStack : this.state.redoStack) || [];
    if (!stack.length) return createErr(ERROR_CODES.SNAPSHOT_NOT_FOUND, 'Core', undoing ? 'There is nothing to undo.' : 'There is nothing to redo.');
    if (this._hasPendingChanges()) return createErr(ERROR_CODES.STALE_DRAFT_DETECTED, 'Core', 'There are draft changes not written yet. Apply or discard them first, then undo or redo.');

    const ab = await this.absorbExternal();
    if (!ab.ok) return ab;
    const entry = stack[stack.length - 1];
    const changes = entry.changes.map(c => undoing ? { path: c.path, before: c.after, after: c.before } : { path: c.path, before: c.before, after: c.after });
    const assets = (entry.assets || []).map(a => undoing ? { path: a.path, before: a.after, after: a.before } : { path: a.path, before: a.before, after: a.after });

    const merge = this._merge(this.liveContent, changes);
    const assetConflicts = [];
    for (const a of assets) { const cur = await this._diskAssetHash(a.path); if (cur !== a.before && cur !== a.after) assetConflicts.push(a.path); }
    if (merge.conflicts.length || assetConflicts.length) {
      return createErr(ERROR_CODES.BASELINE_CONFLICT_DETECTED, 'Core', 'These places were changed again later, so undo or redo is not safe: ' + [...merge.conflicts.map(c => c.path), ...assetConflicts].join(', '),
        { conflicts: merge.conflicts, assetConflicts });
    }
    const valid = this.siteAdapter.validateContent(merge.content);
    if (!valid.ok) return valid;

    const before = this.liveContent;
    const newHash = computeContentHash(merge.content);
    const writeContent = merge.applied.length > 0;
    if (writeContent) { const w = await this._writeLive(merge.content); if (!w.ok) return w; }
    for (const a of assets) {
      const cur = await this._diskAssetHash(a.path); if (cur === a.after) continue;
      const w = await this._writeAsset(a.path, a.after);
      if (!w.ok) { if (writeContent) await this._writeLive(before); return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', `${a.path} could not be written; Sitetend tried to restore it.`); }
    }

    const next = structuredClone(this.state);
    next.baselineContentHash = newHash;
    if (undoing) { next.undoStack = stack.slice(0, -1); next.redoStack = [...(next.redoStack || []), entry]; }
    else { next.redoStack = stack.slice(0, -1); next.undoStack = [...(next.undoStack || []), entry]; }
    const sb = undoing ? entry.beforeSourceBaseline : entry.afterSourceBaseline;
    if (sb && Object.keys(sb).length) next.sourceBaseline = structuredClone(sb); else delete next.sourceBaseline;
    next.assetBaseline = { ...(next.assetBaseline || {}) };
    for (const a of assets) { if (a.after) next.assetBaseline[a.path] = a.after; else delete next.assetBaseline[a.path]; }
    const assetLog = assets.map(a => ({ path: ASSET_PREFIX + a.path, label: a.path, type: 'file', before: a.before, after: a.after, origin: direction }));
    next.maintenanceLogs.unshift({ logId: newId(direction), timestamp: nowIso(), action: undoing ? 'UNDO' : 'REDO', note: (undoing ? 'Undo: ' : 'Redo: ') + (entry.note || ''),
      changes: [...merge.applied.map(c => ({ ...c, origin: direction })), ...assetLog], previousHash: computeContentHash(before), appliedHash: newHash,
      changedFields: [...merge.applied.map(c => c.path), ...assetLog.map(c => c.path)] });
    next.maintenanceLogs = next.maintenanceLogs.slice(0, LOG_LIMIT);
    const stateWrite = await this.workspace.writeJson(PATHS.STATE, next);
    if (!stateWrite.ok) {
      if (writeContent) await this._writeLive(before);
      for (const a of assets) await this._writeAsset(a.path, a.before);
      return createErr(ERROR_CODES.WORKSPACE_IO_ERROR, 'Core', 'The history could not be saved; Sitetend tried to restore the website.');
    }
    const prev = this.state;
    this.state = next;
    this.liveContent = merge.content;
    this.draftContent = structuredClone(merge.content);
    this.draftBase = structuredClone(merge.content);
    this.draftAssets = {};
    this.restoreContext = null;
    this.hasUnsavedDraft = false;
    await this._writeKnown();
    await this.workspace.deleteFile(PATHS.DRAFT);
    await this._gc(prev, next);
    return createOk({ direction, changes: [...merge.applied, ...assetLog], status: this.getStatusSummary() });
  }

  // ------------------------------------------------------------------ history snapshot → draft
  async loadSnapshotIntoDraft(snapshotId) {
    const snapMeta = (this.state?.snapshots || []).find((s) => s.snapshotId === snapshotId);
    if (!snapMeta) return createErr(ERROR_CODES.SNAPSHOT_NOT_FOUND, 'Core', `No snapshot "${snapshotId}".`, { snapshotId });
    const snapRes = await this.workspace.readJson(snapMeta.path);
    if (!snapRes.ok) return snapRes;
    const valid = this.siteAdapter.validateContent(snapRes.data.data.content);
    if (!valid.ok) return valid;
    const version = validateSchemaVersion(snapRes.data.data, 'Snapshot');
    if (!version.ok) return version;
    if (!contentMatchesHash(snapRes.data.data.content, snapMeta.contentHash)) return createErr(ERROR_CODES.STALE_DRAFT_DETECTED, 'Core', 'The snapshot failed its check; the draft was not replaced.');
    const restoreContext = { snapshotId, loadedAt: nowIso(), sourceBaseline: structuredClone(snapRes.data.data.sourceBaseline || {}) };
    const prevContext = this.restoreContext;
    this.restoreContext = restoreContext;
    this.draftBase = structuredClone(this.liveContent);
    const w = await this._writeDraft(structuredClone(snapRes.data.data.content), {}, { restoredFromSnapshot: snapshotId });
    if (!w.ok) { this.restoreContext = prevContext; return w; }
    this.hasUnsavedDraft = true;
    return createOk(this.getStatusSummary());
  }
}
