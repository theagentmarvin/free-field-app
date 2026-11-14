import { z } from 'zod';

/**
 * A Firestore time value as the backend actually writes it.
 *
 * - Cloud Functions that use `FieldValue.serverTimestamp()`
 *   (bootstrapFirstAdmin, onCreateUser) store a Firestore `Timestamp`;
 *   reads return an object with `seconds` / `nanoseconds` /
 *   `toMillis()` (client and admin SDK classes differ, so this is
 *   duck-typed rather than `instanceof`).
 * - Older / transactional writers (redeemInvitation) store epoch
 *   millis as a plain integer.
 *
 * Use `toEpochMillis` to compare or sort either form.
 */
export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
}

export const FirestoreTimestampSchema = z.custom<TimestampLike>(
  (v) =>
    !!v &&
    typeof v === 'object' &&
    typeof (v as TimestampLike).seconds === 'number' &&
    typeof (v as TimestampLike).nanoseconds === 'number' &&
    typeof (v as TimestampLike).toMillis === 'function',
  { message: 'Expected a Firestore Timestamp' },
);

export const FirestoreTimeSchema = z.union([
  z.number().int(),
  FirestoreTimestampSchema,
]);

export type FirestoreTime = z.infer<typeof FirestoreTimeSchema>;

export function toEpochMillis(t: FirestoreTime): number {
  return typeof t === 'number' ? t : t.toMillis();
}
