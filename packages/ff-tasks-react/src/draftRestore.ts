import { draftToCompose, type ComposeFields } from "./composeModel";
import { taskBlobSource } from "./useTaskEngine";

type DraftArg = Parameters<typeof draftToCompose>[0];

/** Anything that can hand back persisted photo bytes by key. */
export interface DraftBlobReader {
  get(blobKey: string): Promise<Blob | undefined>;
}

/**
 * Draft -> compose fields, resolving photo + snapshot bytes from the
 * durable blob store (`registerBlob` persists them), so a draft
 * restored after an app kill / reload keeps its photos and gets real
 * previews. A blob that is genuinely gone (pruned, quota) is dropped
 * rather than left as a dangling ref that would fail the send with
 * `blob-lost`. `draftToCompose` stays the pure, byte-free mapping.
 */
export async function restoreDraftCompose(
  draft: DraftArg,
  source: DraftBlobReader = taskBlobSource,
): Promise<ComposeFields> {
  const base = draftToCompose(draft);
  const mkUrl = (b: Blob): string | undefined =>
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(b)
      : undefined;

  const photos: ComposeFields["photos"] = [];
  for (const p of base.photos) {
    const blob = await source.get(p.blobKey).catch(() => undefined);
    if (!blob) continue;
    photos.push({ ...p, previewUrl: mkUrl(blob) });
  }

  let locationThumb = base.locationThumb;
  if (locationThumb) {
    const blob = await source.get(locationThumb.blobKey).catch(() => undefined);
    locationThumb = blob ? { ...locationThumb, previewUrl: mkUrl(blob) } : null;
  }
  let locationThumb2d = base.locationThumb2d ?? null;
  if (locationThumb2d) {
    const blob = await source.get(locationThumb2d.blobKey).catch(() => undefined);
    locationThumb2d = blob ? { ...locationThumb2d, previewUrl: mkUrl(blob) } : null;
  }
  return { ...base, photos, locationThumb, locationThumb2d };
}
