/**
 * Automated Step 1 Editing Loop & Contract Verification Suite
 * Covers Spec Section 4 (Step 1) & Section 5.4:
 * 1. SchemaVersion validation (rejects missing or unsupported schemaVersion)
 * 2. SiteAdapter (`json-generic`) field enumeration, validation, HTML stripping, and stable project IDs
 * 3. Draft editing & persistence into `.sitetend/drafts/draft.json`
 * 4. Reopening workspace restores unsaved draft accurately
 * 5. External modification conflict detection (Three-Way check B vs C)
 * 6. Applying draft creates snapshot backup in `.sitetend/snapshots/` and writes back to `website/content.json`
 * 7. Reopening workspace after Apply reads the updated `website/content.json` cleanly
 * 8. Snapshot preview & restoration flow
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED_SCHEMA_VERSION,
  ERROR_CODES,
  validateSchemaVersion,
  computeContentHash,
} from '../src/contracts.js';
import { JsonGenericSiteAdapter } from '../src/adapters/json-generic-adapter.js';
import { MemoryBackedWorkspaceAdapter } from '../src/adapters/workspace-adapter.js';
import { SiteKeeperCore } from '../src/core/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const initialContentPath = path.join(__dirname, '../demo-workspace/website/content.json');
const seedContent = JSON.parse(fs.readFileSync(initialContentPath, 'utf-8'));

async function runTests() {
  console.log('=== Running SiteKeeper Step 1 (Editing Loop & Contracts) Tests ===');

  // Test 1: schemaVersion enforcement
  {
    const missingVer = validateSchemaVersion({ profile: {} }, 'test.json');
    assert.equal(missingVer.ok, false);
    assert.equal(missingVer.error.code, ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);

    const futureVer = validateSchemaVersion({ schemaVersion: 99 }, 'test.json');
    assert.equal(futureVer.ok, false);
    assert.equal(futureVer.error.code, ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);

    const validVer = validateSchemaVersion({ schemaVersion: SUPPORTED_SCHEMA_VERSION }, 'test.json');
    assert.equal(validVer.ok, true);
    console.log('✓ Test 1 Passed: schemaVersion validation blocks unsupported versions.');
  }

  // Test 2: SiteAdapter field validation, HTML sanitization & stable project ID lookup
  const siteAdapter = new JsonGenericSiteAdapter();
  {
    const validRes = siteAdapter.validateContent(seedContent);
    assert.equal(validRes.ok, true);
    const paths = siteAdapter.listEditableFields(seedContent).map(f => f.path);
    for (const id of ['orbit-dock', 'fieldnotes', 'common-ground']) assert.ok(paths.includes(`projects.${id}.title`));   // items addressed by stable id

    // Reject unknown field path
    const badField = siteAdapter.setFieldValue(seedContent, 'unknown.field', 'hello');
    assert.equal(badField.ok, false);
    assert.equal(badField.error.code, ERROR_CODES.FIELD_NOT_EDITABLE);

    // Reject invalid email
    const badEmail = siteAdapter.setFieldValue(seedContent, 'contact.email', 'not-an-email');
    assert.equal(badEmail.ok, false);
    assert.equal(badEmail.error.code, ERROR_CODES.FIELD_VALIDATION_FAILED);

    // Strip arbitrary HTML tags during edit
    const xssAttempt = siteAdapter.setFieldValue(
      seedContent,
      'projects.orbit-dock.title',
      '<script>alert(1)</script>Orbit Dock v2.0'
    );
    assert.equal(xssAttempt.ok, true);
    assert.equal(xssAttempt.data.value, 'alert(1)Orbit Dock v2.0');
    console.log('✓ Test 2 Passed: the generic site adapter enforces field contracts and strips HTML.');
  }

  // Test 3: Step 1 Full Editing Loop (Init -> Edit Draft -> Reopen Draft -> Apply -> Reopen Live)
  const workspace = new MemoryBackedWorkspaceAdapter({
    'website/content.json': seedContent,
  });
  const core = new SiteKeeperCore({ workspaceAdapter: workspace, siteAdapter });

  {
    const initRes = await core.initializeWorkspace();
    assert.equal(initRes.ok, true);
    assert.equal(initRes.data.hasUnsavedDraft, false);

    // Edit two fields in draft: contact.email and projects.orbit-dock.summary
    const edit1 = await core.editDraftField('contact.email', 'alex.updated@northfield.edu');
    assert.equal(edit1.ok, true);
    const edit2 = await core.editDraftField(
      'projects.orbit-dock.summary',
      'Updated local context indexer with v2.0 real-time workspace graph.'
    );
    assert.equal(edit2.ok, true);
    assert.equal(edit2.data.status.hasUnsavedDraft, true);
    assert.equal(edit2.data.status.draftDiff.changeCount, 2);

    // Verify live website/content.json on disk is untouched before Apply
    const diskBeforeApply = await workspace.readJson('website/content.json');
    assert.equal(diskBeforeApply.data.data.contact.email, 'alex.morgan.demo@northfield.edu');

    // Simulate closing and reopening the app: draft must be restored from `.sitetend/drafts/draft.json`
    const reopenedCore = new SiteKeeperCore({ workspaceAdapter: workspace, siteAdapter });
    const reopenRes = await reopenedCore.initializeWorkspace();
    assert.equal(reopenRes.ok, true);
    assert.equal(reopenRes.data.hasUnsavedDraft, true);
    assert.equal(reopenRes.data.draftContent.contact.email, 'alex.updated@northfield.edu');
    console.log('✓ Test 3 Passed: Draft edits persist in .sitetend/drafts/draft.json across app restarts without polluting live files.');

    // Test 4: Simulate external manual modification on `website/content.json` -> Conflict Detection!
    // Same field changed outside Sitetend with a different value -> conflict, nothing overwritten.
    const externallyEdited = structuredClone(seedContent);
    externallyEdited.contact.email = 'edited.in.vscode@northfield.edu';
    await workspace.writeJson('website/content.json', externallyEdited);
    const blockedApply = await reopenedCore.applyDraftToWorkspace({ note: 'Try apply over external change' });
    assert.equal(blockedApply.ok, false);
    assert.equal(blockedApply.error.code, ERROR_CODES.BASELINE_CONFLICT_DETECTED);
    assert.deepEqual(blockedApply.error.details.conflicts.map(c => c.path), ['contact.email']);
    assert.equal((await workspace.readJson('website/content.json')).data.data.contact.email, 'edited.in.vscode@northfield.edu');
    console.log('✓ Test 4 Passed: Field-level three-way check blocks overwriting an external edit to the same field.');

    // Restore clean baseline on disk, then Apply draft normally
    await workspace.writeJson('website/content.json', seedContent);
    const applyRes = await reopenedCore.applyDraftToWorkspace({ note: 'Update email and Orbit Dock summary' });
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.data.appliedChanges.length, 2);
    assert.equal(applyRes.data.status.hasUnsavedDraft, false);

    // Verify snapshot was created and live file was updated
    const stateAfterApply = await workspace.readJson('.sitetend/state.json');
    assert.equal(stateAfterApply.data.data.snapshots.length, 1);

    // Reopen a brand new Core instance and verify persisted live changes
    const finalCore = new SiteKeeperCore({ workspaceAdapter: workspace, siteAdapter });
    const finalInit = await finalCore.initializeWorkspace();
    assert.equal(finalInit.ok, true);
    assert.equal(finalInit.data.hasUnsavedDraft, false);
    assert.equal(finalInit.data.liveContent.contact.email, 'alex.updated@northfield.edu');
    assert.equal(
      finalInit.data.liveContent.projects.find((p) => p.id === 'orbit-dock').summary,
      'Updated local context indexer with v2.0 real-time workspace graph.'
    );
    console.log('✓ Test 5 Passed: Apply writes back to website/content.json, creates snapshot backup, and reopening reads updated state.');

    // Test 6: Load previous snapshot into draft for safe preview/restoration
    const snapId = stateAfterApply.data.data.snapshots[0].snapshotId;
    const restoreRes = await finalCore.loadSnapshotIntoDraft(snapId);
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.data.hasUnsavedDraft, true);
    assert.equal(restoreRes.data.draftContent.contact.email, 'alex.morgan.demo@northfield.edu');
    console.log('✓ Test 6 Passed: Snapshot restoration loads historical version into draft for preview before applying.');
  }

  console.log('=== All 6 Step 1 Contract & Editing Loop Tests Passed! ===');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
