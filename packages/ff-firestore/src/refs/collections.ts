/**
 * Typed Firestore collection references. Centralized so all client code
 * uses the same path strings (no typo risk) and benefits from typed doc
 * snapshots (User | Project | Building | Folder | Member | Invitation | AuditLog).
 */

import {
  collection,
  doc,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';

import type { User } from '../schema/user';
import type { Project } from '../schema/project';
import type { Building } from '../schema/building';
import type { Folder } from '../schema/folder';
import type { Member } from '../schema/member';
import type { Invitation } from '../schema/invitation';
import type { AuditLog } from '../schema/auditLog';
import type { Task } from '../schema/task';
import type { TaskEntry } from '../schema/taskEntry';

export function usersCollection(db: Firestore): CollectionReference<User> {
  return collection(db, 'users') as CollectionReference<User>;
}

export function userDoc(db: Firestore, uid: string): DocumentReference<User> {
  return doc(db, 'users', uid) as DocumentReference<User>;
}

export function projectsCollection(db: Firestore): CollectionReference<Project> {
  return collection(db, 'projects') as CollectionReference<Project>;
}

export function projectDoc(
  db: Firestore,
  projectId: string
): DocumentReference<Project> {
  return doc(db, 'projects', projectId) as DocumentReference<Project>;
}

export function buildingsCollection(
  db: Firestore,
  projectId: string
): CollectionReference<Building> {
  return collection(
    db,
    'projects',
    projectId,
    'buildings'
  ) as CollectionReference<Building>;
}

export function foldersCollection(
  db: Firestore,
  projectId: string
): CollectionReference<Folder> {
  return collection(
    db,
    'projects',
    projectId,
    'folders'
  ) as CollectionReference<Folder>;
}

export function membersCollection(
  db: Firestore,
  projectId: string
): CollectionReference<Member> {
  return collection(
    db,
    'projects',
    projectId,
    'members'
  ) as CollectionReference<Member>;
}

export function invitationsCollection(
  db: Firestore,
  projectId: string
): CollectionReference<Invitation> {
  return collection(
    db,
    'projects',
    projectId,
    'invitations'
  ) as CollectionReference<Invitation>;
}

export function auditLogCollection(
  db: Firestore,
  projectId: string
): CollectionReference<AuditLog> {
  return collection(
    db,
    'projects',
    projectId,
    'auditLog'
  ) as CollectionReference<AuditLog>;
}

// ── Tasks module (plan 2026-11-01 §2.1) ──────────────────────────
// projects/{pid}/tasks/{taskId} + append-only /entries/{entryId}
// (docId == clientGuid) + a single-doc counter
// projects/{pid}/taskCounters/tasks { next } for per-project "T-"
// numbers.

export function tasksCollection(
  db: Firestore,
  projectId: string
): CollectionReference<Task> {
  return collection(
    db,
    'projects',
    projectId,
    'tasks'
  ) as CollectionReference<Task>;
}

export function taskDoc(
  db: Firestore,
  projectId: string,
  taskId: string
): DocumentReference<Task> {
  return doc(db, 'projects', projectId, 'tasks', taskId) as DocumentReference<Task>;
}

export function taskEntriesCollection(
  db: Firestore,
  projectId: string,
  taskId: string
): CollectionReference<TaskEntry> {
  return collection(
    db,
    'projects',
    projectId,
    'tasks',
    taskId,
    'entries'
  ) as CollectionReference<TaskEntry>;
}

/** Entry docId IS the clientGuid — the idempotency key (rules enforce). */
export function taskEntryDoc(
  db: Firestore,
  projectId: string,
  taskId: string,
  clientGuid: string
): DocumentReference<TaskEntry> {
  return doc(
    db,
    'projects',
    projectId,
    'tasks',
    taskId,
    'entries',
    clientGuid
  ) as DocumentReference<TaskEntry>;
}

export function taskCounterDoc(db: Firestore, projectId: string): DocumentReference<{ next: number }> {
  return doc(db, 'projects', projectId, 'taskCounters', 'tasks') as DocumentReference<{ next: number }>;
}