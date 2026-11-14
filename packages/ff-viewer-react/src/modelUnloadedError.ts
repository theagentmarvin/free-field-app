/**
 * Thrown by a long-running per-model query (e.g. the property-index
 * walk behind `getPropertyDataForModel`) when the model it is reading
 * is disposed mid-flight — building switch, version swap or a viewer
 * remount. It is a normal lifecycle event, not a failure: callers
 * should drop the partial result quietly and rebuild once the model
 * is loaded again.
 *
 * Consumers in other packages may match on `err.name` instead of
 * `instanceof`, so the name is part of the contract.
 */
export class ModelUnloadedError extends Error {
  readonly modelId: string;

  constructor(modelId: string) {
    super(`Model ${modelId} was unloaded while it was being read`);
    this.name = "ModelUnloadedError";
    this.modelId = modelId;
  }
}

export function isModelUnloadedError(err: unknown): boolean {
  return err instanceof Error && err.name === "ModelUnloadedError";
}
