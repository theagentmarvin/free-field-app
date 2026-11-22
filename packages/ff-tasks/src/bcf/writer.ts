import JSZip from 'jszip';
import { PRIORITY_LABELS, isTaskPriority } from '../taskFields';
import { cameraToBcf, formatNumber, type BcfCamera } from './camera';
import { guidFor } from './guid';
import { readImageSize } from './imageInfo';
import { statusLabel } from './labels';
import type {
  BcfBinary,
  BcfComponent,
  BcfEntrySource,
  BcfExportOptions,
  BcfExportResult,
  BcfTaskBundle,
  BcfVersion,
  BcfWarning,
  BuildBcfFiles,
  ExportBcf,
  Vec3,
} from './types';
import { serializeXml, xe, xt, type XChild, type XNode } from './xml';

const MAX_SNAPSHOT_SIDE = 1500;
const IFC_GUID_RE = /^[0-9A-Za-z_$]{22}$/;

// ---------- small helpers ----------

export function formatTaskNum(num: number): string {
  return `T${String(num).padStart(3, '0')}`;
}

const MAX_DATE_MS = 253402300799000;

/** True for 0 < ms <= year 9999. */
export function isValidDateMs(ms: unknown): ms is number {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS;
}

/** Never throws: out-of-range values are clamped into the valid range. */
export function toBcfDate(ms: number): string {
  if (!Number.isFinite(ms)) ms = 0;
  ms = Math.min(Math.max(ms, 0), MAX_DATE_MS);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const nonBlank = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim() !== '';

function capitalise(s: string): string {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Task';
}

function priorityLabel(p: string | null | undefined): string | null {
  if (!nonBlank(p)) return null;
  return isTaskPriority(p) ? PRIORITY_LABELS[p] : capitalise(p);
}

export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'project';
}

export function imageExtension(mime: string): string {
  const m = mime.toLowerCase().trim();
  if (m === 'image/jpeg' || m === 'image/jpg' || m === 'image/pjpeg') return 'jpg';
  if (m === 'image/png') return 'png';
  if (m === 'image/webp') return 'webp';
  if (m === 'image/heic') return 'heic';
  if (m === 'image/heif') return 'heif';
  if (m === 'image/gif') return 'gif';
  const sub = m.split('/')[1]?.replace(/[^a-z0-9]/g, '');
  return sub || 'bin';
}

const isPng = (b: BcfBinary) => b.mime.toLowerCase() === 'image/png';
const isJpeg = (b: BcfBinary) => /^image\/(jpeg|jpg|pjpeg)$/i.test(b.mime);

function sizeOf(b: BcfBinary): { width: number; height: number } | null {
  if (b.width && b.height && b.width > 0 && b.height > 0) return { width: b.width, height: b.height };
  return readImageSize(b.bytes);
}

// ---------- description / comments ----------

export function buildDescription(b: BcfTaskBundle): string | null {
  const t = b.task;
  const ctx: string[] = ['FreeField', `Task ${formatTaskNum(t.num)}`];
  if (nonBlank(t.buildingName)) ctx.push(`Building: ${t.buildingName.trim()}`);
  if (nonBlank(t.storeyName)) ctx.push(`Storey: ${t.storeyName.trim()}`);
  if (nonBlank(t.locationText)) ctx.push(`Location: ${t.locationText.trim()}`);
  if (nonBlank(t.sheetPinNote)) ctx.push(`2D pin: ${t.sheetPinNote.trim()}`);
  if (t.sheetRefs && t.sheetRefs.length > 0) {
    const parts = t.sheetRefs.map((s) => {
      const extra: string[] = [];
      if (s.versionNumber != null) extra.push(`v${s.versionNumber}`);
      if (s.page != null) extra.push(`p.${s.page}`);
      return extra.length ? `${s.name} (${extra.join(', ')})` : s.name;
    });
    ctx.push(`Sheets: ${parts.join(', ')}`);
  }
  if (t.checklist && t.checklist.length > 0) {
    ctx.push('Checklist:');
    for (const c of t.checklist) ctx.push(`[${c.done ? 'x' : ' '}] ${c.text}`);
  }
  const user = (t.description ?? '').trim();
  const block = ctx.join('\n');
  return user ? `${user}\n\n${block}` : block;
}

const ACTION_WORDS: Record<string, string> = {
  create: 'Created',
  assign: 'Assigned',
  complete: 'Completed',
  reject: 'Rejected',
  approve: 'Approved',
  followup: 'Follow-up requested',
  discontinue: 'Discontinued',
  edit: 'Edited',
  comment: 'Comment',
};

export function commentText(e: BcfEntrySource): string {
  const text = (e.text ?? '').trim();
  switch (e.action) {
    case 'create':
      return 'Created';
    case 'comment':
      return text || ACTION_WORDS.comment!;
    case 'edit':
      return text ? `Edited\n${text}` : 'Edited';
    case 'assign':
    case 'complete':
    case 'reject':
    case 'approve':
    case 'followup':
    case 'discontinue': {
      const head =
        e.statusFrom != null && e.statusTo != null
          ? `Status: ${statusLabel(e.statusFrom)} \u2192 ${statusLabel(e.statusTo)}`
          : ACTION_WORDS[e.action]!;
      return text ? `${head}\n${text}` : head;
    }
    default:
      return text || ACTION_WORDS[e.action] || e.action || 'Comment';
  }
}

// ---------- viewpoint file ----------

function point(name: string, v: Vec3): XNode {
  return xe(name, undefined, [xt('X', formatNumber(v[0])), xt('Y', formatNumber(v[1])), xt('Z', formatNumber(v[2]))]);
}

function componentNode(c: BcfComponent): XNode {
  return xe('Component', { IfcGuid: c.ifcGuid }, [
    nonBlank(c.originatingSystem) && xt('OriginatingSystem', c.originatingSystem),
    nonBlank(c.authoringToolId) && xt('AuthoringToolId', c.authoringToolId),
  ]);
}

export function buildViewpointXml(
  guid: string,
  camera: BcfCamera | null,
  components: readonly BcfComponent[],
  version: BcfVersion,
): string {
  const comps =
    components.length > 0
      ? xe('Components', undefined, [
          xe('Selection', undefined, components.map(componentNode)),
          xe('Visibility', { DefaultVisibility: true }),
        ])
      : null;
  const cam = !camera
    ? null
    : camera.kind === 'perspective'
      ? xe('PerspectiveCamera', undefined, [
          point('CameraViewPoint', camera.viewPoint),
          point('CameraDirection', camera.direction),
          point('CameraUpVector', camera.up),
          xt('FieldOfView', formatNumber(camera.fieldOfView!)),
          version === '3.0' && xt('AspectRatio', formatNumber(camera.aspectRatio!)),
        ])
      : xe('OrthogonalCamera', undefined, [
          point('CameraViewPoint', camera.viewPoint),
          point('CameraDirection', camera.direction),
          point('CameraUpVector', camera.up),
          xt('ViewToWorldScale', formatNumber(camera.viewToWorldScale!)),
          version === '3.0' && xt('AspectRatio', formatNumber(camera.aspectRatio!)),
        ]);
  return serializeXml(xe('VisualizationInfo', { Guid: guid }, [comps, cam]));
}

// ---------- per-topic build ----------

interface DocEntry {
  guid: string;
  refGuid: string;
  filename: string;
  path: string;
  description: string;
  binary: BcfBinary;
}

interface TopicOut {
  guid: string;
  files: Map<string, string | Uint8Array>;
  docs: DocEntry[];
  type: string;
  status: string;
  priority: string | null;
  labels: string[];
  users: string[];
}

async function buildTopic(
  bundle: BcfTaskBundle,
  options: BcfExportOptions,
  warnings: BcfWarning[],
  now: number,
): Promise<TopicOut> {
  const v = options.version;
  const t = bundle.task;
  const warn = (kind: BcfWarning['kind'], message: string) =>
    warnings.push({ taskId: t.id, taskNum: t.num, kind, message });

  const topicGuid = guidFor('task', t.id);
  const folder = topicGuid;
  const files = new Map<string, string | Uint8Array>();
  const users = new Set<string>();
  const user = (s: string | null | undefined): string | null => {
    if (!nonBlank(s)) return null;
    users.add(s);
    return s;
  };

  const creationAuthor =
    user(options.users.author(t.createdByUid, t.createdBy)) ?? user(t.createdBy) ?? user(t.createdByUid) ?? user('unknown')!;
  const modifiedAuthor = nonBlank(t.updatedBy)
    ? user(options.users.authorByName?.(t.updatedBy) ?? t.updatedBy)
    : null;
  const assignedTo =
    t.assigneeUid || nonBlank(t.assigneeName) ? user(options.users.author(t.assigneeUid, t.assigneeName)) ?? user(t.assigneeName) : null;

  // --- snapshot ---
  let snapshot: BcfBinary | null = null;
  let snapshotName: string | null = null;
  if (bundle.snapshot && bundle.snapshot.bytes.length > 0) {
    let s = bundle.snapshot;
    const needsPng = v === '2.1' ? !isPng(s) : !isPng(s) && !isJpeg(s);
    if (needsPng && options.convertToPng) {
      try {
        s = await options.convertToPng(s);
      } catch {
        /* fall through to the unconverted bytes */
      }
    }
    const okFormat = v === '2.1' ? isPng(s) : isPng(s) || isJpeg(s);
    if (!okFormat) warn('snapshot-not-png', v === '2.1' ? 'Snapshot is not PNG (BCF 2.1 expects PNG)' : 'Snapshot is neither PNG nor JPEG');
    snapshot = s;
    snapshotName = `snapshot.${imageExtension(s.mime)}`;
    const sz = sizeOf(s);
    if (sz && Math.max(sz.width, sz.height) > MAX_SNAPSHOT_SIDE) {
      warn('snapshot-downscaled', `Snapshot is ${sz.width}x${sz.height}, which exceeds the recommended ${MAX_SNAPSHOT_SIDE}px long side`);
    }
    files.set(`${folder}/${snapshotName}`, s.bytes);
  }

  // --- viewpoint ---
  const shift = typeof options.baseShift === 'function' ? options.baseShift(t.id) : options.baseShift;
  const vpGuid = guidFor('viewpoint', t.id);
  const goodComps: BcfComponent[] = [];
  let unresolved = bundle.unresolvedComponents ?? 0;
  const seen = new Set<string>();
  for (const c of bundle.components ?? []) {
    if (!IFC_GUID_RE.test(c.ifcGuid)) { unresolved++; continue; }
    if (seen.has(c.ifcGuid)) continue;
    seen.add(c.ifcGuid);
    goodComps.push(c);
  }
  if (unresolved > 0) warn('unresolved-elements', `${unresolved} linked element(s) could not be resolved to IFC GUIDs`);

  let hasBcfv = false;
  const pose = t.cameraPose;
  const poseOk =
    !!pose &&
    [...pose.pos, ...pose.target, pose.fov].every((n) => Number.isFinite(n)) &&
    pose.pos.some((n, i) => n !== pose.target[i]);
  if (pose && shift && poseOk && shift.every((n) => Number.isFinite(n))) {
    const sz = snapshot ? sizeOf(snapshot) : null;
    const aspect = sz ? sz.width / sz.height : 16 / 9;
    const cam = cameraToBcf(pose, shift, v, aspect);
    if (cam.kind === 'orthogonal') warn('ortho-scale-estimated', 'Orthographic zoom is not stored; view scale estimated');
    files.set(`${folder}/viewpoint.bcfv`, buildViewpointXml(vpGuid, cam, goodComps, v));
    hasBcfv = true;
  } else if (t.cameraPose || goodComps.length > 0) {
    warn('no-3d-view', t.cameraPose ? (shift ? 'Camera pose is invalid; 3D view not written' : 'No base-model shift known; 3D view not written') : 'Linked elements without a camera; 3D view not written');
  }

  // In 2.1 a snapshot with no 3D view still gets a camera-less .bcfv (only the
  // selection when known): strict readers reject a Viewpoints entry whose
  // viewpoint file is missing. (3.0 requires a camera in the .bcfv, so there the
  // ViewPoint holds only the snapshot.)
  if (!hasBcfv && snapshotName && v === '2.1') {
    files.set(`${folder}/viewpoint.bcfv`, buildViewpointXml(vpGuid, null, goodComps, v));
    hasBcfv = true;
  }

  // --- photos ---
  const docs: DocEntry[] = [];
  const photos = bundle.photos ?? [];
  photos.forEach((p, i) => {
    if (!p.binary || p.binary.bytes.length === 0) {
      warn('photo-skipped', `Photo ${i + 1} has no data`);
      return;
    }
    const ext = imageExtension(p.binary.mime);
    const guid = guidFor('doc', `${t.id}:${i}`);
    const base = `photo-${i + 1}.${ext}`;
    const path = v === '3.0' ? `Documents/${guid}` : `Documents/${guid}.${ext}`;
    docs.push({
      guid,
      refGuid: guidFor('docref', `${t.id}:${i}`),
      filename: base,
      path,
      description: nonBlank(p.caption) ? p.caption.trim() : `Photo ${i + 1}`,
      binary: p.binary,
    });
  });

  // 3.0: a ViewPoint without a viewpoint file is rejected by strict readers, and
  // the 3.0 .bcfv must carry a camera. A snapshot with no 3D view is therefore
  // attached as a document instead of a ViewPoint.
  if (v === '3.0' && snapshot && snapshotName && !hasBcfv) {
    files.delete(`${folder}/${snapshotName}`);
    const guid = guidFor('doc', `${t.id}:snapshot`);
    docs.unshift({
      guid,
      refGuid: guidFor('docref', `${t.id}:snapshot`),
      filename: `location-snapshot.${imageExtension(snapshot.mime)}`,
      path: `Documents/${guid}`,
      description: 'Location snapshot',
      binary: snapshot,
    });
    snapshotName = null;
  }

  // --- markup ---
  const labels = [t.buildingName, t.storeyName].filter(nonBlank).map((s) => s.trim());
  const dedupLabels = [...new Set(labels)];
  const prio = priorityLabel(t.priority);
  const type = capitalise(t.type);
  const status = statusLabel(t.status);
  const url = options.taskUrl?.(t.id);
  const created = isValidDateMs(t.createdAt) ? t.createdAt : now;
  const description = buildDescription(bundle);

  const docRefs = docs.map((d) =>
    v === '3.0'
      ? xe('DocumentReference', { Guid: d.refGuid }, [xt('DocumentGuid', d.guid), xt('Description', d.description)])
      : xe('DocumentReference', { Guid: d.refGuid, isExternal: false }, [
          xt('ReferencedDocument', `../${d.path}`),
          xt('Description', d.description),
        ]),
  );

  const topicChildren: XChild[] = [];
  if (nonBlank(url)) {
    topicChildren.push(v === '3.0' ? xe('ReferenceLinks', undefined, [xt('ReferenceLink', url)]) : xt('ReferenceLink', url));
  }
  topicChildren.push(xt('Title', nonBlank(t.title) ? t.title.trim() : '(untitled)'));
  if (prio) topicChildren.push(xt('Priority', prio));
  if (v === '2.1' && Number.isFinite(t.num)) topicChildren.push(xt('Index', String(Math.trunc(t.num))));
  if (dedupLabels.length > 0) {
    if (v === '3.0') topicChildren.push(xe('Labels', undefined, dedupLabels.map((l) => xt('Label', l))));
    else for (const l of dedupLabels) topicChildren.push(xt('Labels', l));
  }
  topicChildren.push(xt('CreationDate', toBcfDate(created)), xt('CreationAuthor', creationAuthor));
  if (isValidDateMs(t.updatedAt)) topicChildren.push(xt('ModifiedDate', toBcfDate(t.updatedAt)));
  if (modifiedAuthor && isValidDateMs(t.updatedAt)) topicChildren.push(xt('ModifiedAuthor', modifiedAuthor));
  if (isValidDateMs(t.deadline)) topicChildren.push(xt('DueDate', toBcfDate(t.deadline)));
  if (assignedTo) topicChildren.push(xt('AssignedTo', assignedTo));
  if (description) topicChildren.push(xt('Description', description));
  if (docRefs.length > 0) {
    if (v === '3.0') topicChildren.push(xe('DocumentReferences', undefined, docRefs));
    else topicChildren.push(...docRefs);
  }

  const comments = bundle.entries.map((e) => {
    const author = user(options.users.author(e.byUid, e.by)) ?? user(e.by) ?? user(e.byUid) ?? 'unknown';
    return xe('Comment', { Guid: guidFor('entry', e.id) }, [
      xt('Date', toBcfDate(isValidDateMs(e.at) ? e.at : now)),
      xt('Author', author),
      xt('Comment', commentText(e)),
    ]);
  });

  const vpNode =
    hasBcfv || snapshotName
      ? xe(v === '3.0' ? 'ViewPoint' : 'Viewpoints', { Guid: vpGuid }, [
          hasBcfv && xt('Viewpoint', 'viewpoint.bcfv'),
          snapshotName && xt('Snapshot', snapshotName),
          xt('Index', '0'),
        ])
      : null;

  const topicAttrs = { Guid: topicGuid, TopicType: type, TopicStatus: status };
  let root: XNode;
  if (v === '3.0') {
    if (comments.length > 0) topicChildren.push(xe('Comments', undefined, comments));
    if (vpNode) topicChildren.push(xe('Viewpoints', undefined, [vpNode]));
    root = xe('Markup', undefined, [xe('Topic', topicAttrs, topicChildren)]);
  } else {
    root = xe('Markup', undefined, [xe('Topic', topicAttrs, topicChildren), ...comments, vpNode]);
  }
  files.set(`${folder}/markup.bcf`, serializeXml(root));

  return {
    guid: topicGuid,
    files,
    docs,
    type,
    status,
    priority: prio,
    labels: dedupLabels,
    users: [...users],
  };
}

// ---------- public API ----------

export const buildBcfFiles: BuildBcfFiles = async (bundles, options) => {
  const v = options.version;
  const now = (options.now ?? Date.now)();
  const warnings: BcfWarning[] = [];
  const files = new Map<string, string | Uint8Array>();

  files.set(
    'bcf.version',
    serializeXml(
      v === '2.1'
        ? xe('Version', { VersionId: '2.1' }, [xt('DetailedVersion', '2.1')])
        : xe('Version', { VersionId: '3.0' }),
    ),
  );

  const projectId = nonBlank(options.project.id) ? options.project.id : 'freefield';
  const projectNode = xe('Project', { ProjectId: projectId }, [nonBlank(options.project.name) && xt('Name', options.project.name.trim())]);
  files.set(
    'project.bcfp',
    serializeXml(
      v === '2.1'
        ? xe('ProjectExtension', undefined, [projectNode, xe('ExtensionSchema')])
        : xe('ProjectInfo', undefined, [projectNode]),
    ),
  );

  const types = new Set<string>();
  const statuses = new Set<string>();
  const priorities = new Set<string>();
  const labels = new Set<string>();
  const users = new Set<string>();
  const allDocs: DocEntry[] = [];
  const seenTopics = new Set<string>();

  for (let i = 0; i < bundles.length; i++) {
    const bundle = bundles[i]!;
    const topic = await buildTopic(bundle, options, warnings, now);
    if (!seenTopics.has(topic.guid)) {
      seenTopics.add(topic.guid);
      for (const [p, c] of topic.files) files.set(p, c);
      topic.docs.forEach((d) => allDocs.push(d));
      types.add(topic.type);
      statuses.add(topic.status);
      if (topic.priority) priorities.add(topic.priority);
      topic.labels.forEach((l) => labels.add(l));
      topic.users.forEach((u) => users.add(u));
    }
    options.onProgress?.(i + 1, bundles.length);
  }

  for (const d of allDocs) files.set(d.path, d.binary.bytes);

  if (v === '3.0') {
    const list = (container: string, item: string, vals: Set<string>): XNode | null =>
      vals.size > 0 ? xe(container, undefined, [...vals].map((x) => xt(item, x))) : null;
    files.set(
      'extensions.xml',
      serializeXml(
        xe('Extensions', undefined, [
          list('TopicTypes', 'TopicType', types),
          list('TopicStatuses', 'TopicStatus', statuses),
          list('Priorities', 'Priority', priorities),
          list('TopicLabels', 'TopicLabel', labels),
          list('Users', 'User', users),
        ]),
      ),
    );
    if (allDocs.length > 0) {
      files.set(
        'documents.xml',
        serializeXml(
          xe('DocumentInfo', undefined, [
            xe(
              'Documents',
              undefined,
              allDocs.map((d) => xe('Document', { Guid: d.guid }, [xt('Filename', d.filename), xt('Description', d.description)])),
            ),
          ]),
        ),
      );
    }
  }

  return { files, warnings };
};

export const exportBcf: ExportBcf = async (bundles, options): Promise<BcfExportResult> => {
  const now = (options.now ?? Date.now)();
  const { files, warnings } = await buildBcfFiles(bundles, { ...options, now: () => now });
  const zip = new JSZip();
  const date = new Date(now);
  const dirs = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const [path, content] of files) {
    const binary = typeof content !== 'string';
    zip.file(path, content, { date, createFolders: false, compression: binary ? 'STORE' : 'DEFLATE' });
  }
  for (const d of [...dirs].sort()) zip.file(d + '/', null, { dir: true, date, createFolders: false }); // explicit directory entries
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    mimeType: 'application/octet-stream',
  });
  const day = date.toISOString().slice(0, 10);
  const filename = `freefield-${slug(options.project.name || options.project.id || '')}-${day}-${options.version === '2.1' ? 'bcf21.bcfzip' : 'bcf30.bcf'}`;
  return { blob, filename, topicCount: files.size === 0 ? 0 : countTopics(files), warnings };
};

function countTopics(files: Map<string, unknown>): number {
  let n = 0;
  for (const k of files.keys()) if (k.endsWith('/markup.bcf')) n++;
  return n;
}
