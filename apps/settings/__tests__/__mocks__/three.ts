// Stub for 'three' to prevent three.webgpu.js from loading in jsdom tests.
// three.js tries to access WebGPU constants at module scope, which crashes
// in Node.js/jsdom environments.

export default {};

export const PerspectiveCamera = class {};
export const Vector3 = class {};
export const Mesh = class {};
export const Group = class {};
export const Object3D = class {};
export const Scene = class {};
export const WebGLRenderer = class {};
export const Color = class {};
export const Material = class {};
export const MeshBasicMaterial = class {};
export const MeshStandardMaterial = class {};
export const BufferGeometry = class {};
export const PlaneGeometry = class {};
export const Box3 = class {};
export const Vector2 = class {};
export const Matrix4 = class {};
export const Raycaster = class {};
export const Line3 = class {};
export const Plane = class {};
export const Spherical = class {};
export const Euler = class {};
export const Quaternion = class {};
export const Frustum = class {};
export const BoxGeometry = class {};

export const REVISION = "mock";
export const MathUtils = {
  radToDeg: (r: number) => r * 180 / Math.PI,
  degToRad: (d: number) => d * Math.PI / 180,
};

export const NoBlending = 0;
export const NormalBlending = 1;
export const AdditiveBlending = 2;
export const SubtractiveBlending = 3;
export const MultiplyBlending = 4;
export const CustomBlending = 5;
export const CullFaceNone = 0;
export const CullFaceBack = 1;
export const CullFaceFront = 2;
export const DoubleSide = 2;
export const FrontSide = 0;
export const BackSide = 1;
export const LinearFilter = 1006;
export const NearestFilter = 1008;
export const RGBAFormat = 1023;
export const UnsignedByteType = 1009;
export const FloatType = 1010;
export const ClampToEdgeWrapping = 1001;
export const RepeatWrapping = 1000;
export const MirroredRepeatWrapping = 1002;
export const AlwaysDepth = 1;
export const LessEqualDepth = 3;
export const GreaterDepth = 5;
export const SRGBColorSpace = "srgb";
export const LinearSRGBColorSpace = "srgb-linear";
export const NoColorSpace = "";
export const DisplayP3ColorSpace = "display-p3";
