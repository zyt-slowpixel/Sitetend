/**
 * Publisher Contract (v0.3 Spec Section 5.1)
 *
 * Responsibilities:
 * - Publishes an explicitly approved local version and returns deployment status.
 * - Strictly separates "Apply to Local Folder" from "Online Publish".
 * - Never auto-approves unreviewed draft changes.
 */

import { ERROR_CODES, createOk, createErr } from '../contracts.js';

export class GitManualBundlePublisher {
  constructor() {
    this.publisherId = 'git-local-export';
    this.displayName = 'Local Git / GitHub Pages Ready Bundle';
  }

  async publishVersion({ baselineHash, hasUnsavedDraft }) {
    if (hasUnsavedDraft) {
      return createErr(
        ERROR_CODES.PUBLISH_FAILED,
        'Publisher',
        'There are draft changes not written to the folder yet. Apply them first, then publish.',
        { baselineHash, hasUnsavedDraft }
      );
    }

    return createOk({
      publisherId: this.publisherId,
      publishedHash: baselineHash,
      publishedAt: new Date().toISOString(),
      instructions: 'The website/ folder has the latest approved version. Publish it with git add website/ && git commit && git push (for example to GitHub Pages).',
    });
  }
}
