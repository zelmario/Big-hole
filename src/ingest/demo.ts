/**
 * The demo capture that ships with the built site.
 *
 * The tool cannot be tried without a capture, and a capture is the one thing a first-time
 * visitor does not have: a support bundle is somebody's production data, and asking for one
 * before showing anything is the wrong way round. So a real one is built into the site, and a
 * button loads it down the same path a dropped folder takes -- `File` objects handed to
 * `ingest`, decoded in the workers, written to OPFS. Nothing about the demo is a special case
 * downstream; it is a drop that the page performs on the visitor's behalf.
 *
 * ## The one fetch in the codebase
 *
 * This module is the sole entry on the privacy gate's allowlist (tests/privacy.test.ts), and
 * it is worth being exact about why, because "we made an exception" is how a promise like
 * "your data never leaves your machine" stops being true.
 *
 * The promise is about data flowing OUT. These requests are same-origin GETs for assets the
 * site already shipped -- the bytes travel from the server that served the page to the page,
 * and no capture the visitor loaded is read, named or referenced. A hostile version of this
 * file would have to send something, and there is nothing here that can: no request body, no
 * query built from state, no destination that is not a relative path under this site's own
 * base. The CSP forbids other origins in any case.
 *
 * That is also why the fetching lives in one small module rather than in the component that
 * needs it. The gate's allowlist is the reviewable surface, and it stays a one-file review.
 */

import type { SourceFile } from './discover.js';

/** What `public/demo/manifest.json` holds. */
export interface DemoManifest {
  /** Short description of the capture, shown on the button. */
  readonly label: string;
  /** A sentence about what is in it. */
  readonly note: string;
  /** Paths relative to the demo directory, in no particular order. */
  readonly files: readonly string[];
}

/**
 * Where the demo lives at runtime.
 *
 * `BASE_URL` is what makes this work on a project page. GitHub Pages serves the site from
 * `/Big-hole/`, not from the root, so a leading-slash path would ask for `/demo/…` and get the
 * user's 404 page -- and, because a 404 body is HTML that parses as neither BSON nor JSON, the
 * failure would surface as a decode error rather than as a missing file.
 */
function demoRoot(): string {
  return `${import.meta.env.BASE_URL}demo/`;
}

/** The manifest, or null when the build shipped no demo. */
export async function demoManifest(): Promise<DemoManifest | null> {
  try {
    const response = await fetch(`${demoRoot()}manifest.json`);
    if (!response.ok) return null;
    return (await response.json()) as DemoManifest;
  } catch {
    // Offline, or a build without the asset. The button simply does not appear.
    return null;
  }
}

/**
 * Fetch the demo capture as the `SourceFile`s a folder drop would have produced.
 *
 * Paths are kept relative to the demo directory rather than to the site, because that is the
 * tree `groupCaptures` reads: one capture per member comes from the directory each
 * `diagnostic.data` sits in, and prefixing every path with the deployment's base would still
 * group correctly but would put the base into the node labels.
 *
 * Requests go out together. It is a handful of files against the same origin that just served
 * the page, and the slow part by far is decoding them afterwards.
 */
export async function fetchDemoCapture(manifest: DemoManifest): Promise<SourceFile[]> {
  const root = demoRoot();

  return Promise.all(
    manifest.files.map(async (path) => {
      const response = await fetch(root + path);
      if (!response.ok) {
        throw new Error(`demo capture is missing ${path} (${response.status})`);
      }
      const blob = await response.blob();
      const name = path.split('/').pop() ?? path;
      return { file: new File([blob], name), path };
    }),
  );
}
