/**
 * @ff/firestore — schemas, typed collection refs, rules, and Cloud Functions.
 *
 * Per plan v3 §6.2: this is the data-contract surface. Architect reviews
 * record shapes during integration. Schemas are Zod-validated at runtime;
 * refs are typed for client SDK use.
 */

export * from './schema/timestamp';
export * from './schema/user';
export * from './schema/project';
export * from './schema/building';
export * from './schema/folder';
export * from './schema/member';
export * from './schema/invitation';
export * from './schema/auditLog';
export * from './schema/task';
export * from './schema/taskEntry';
export * from './refs/collections';
export * from './app';