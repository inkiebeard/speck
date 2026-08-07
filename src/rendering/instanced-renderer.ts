import * as THREE from 'three';
import type { Entity } from '../core/entity';
import { ArrayComponentStore } from '../core/component-store';
import { TransformStore } from '../components/transform';

/**
 * One THREE.InstancedMesh per visual type id => one draw call per type, no
 * matter how many entities share it. Each frame `sync()` walks the transform
 * store in dense order and writes each entity's matrix into the InstancedMesh
 * for its type. It also records instanceIndex -> entity per type so a raycast
 * hit (which gives you an instanceId) can be resolved back to an entity — which
 * is exactly what drag-picking in the matching game needs.
 */
// Neutral instance-color multiplier (finalColor = materialColor * instanceColor),
// i.e. "no tint" — what setInstanceColor(..., null) resets an instance back to.
const NEUTRAL_COLOR = new THREE.Color(1, 1, 1);

export class InstancedRenderer {
  private meshes = new Map<number, THREE.InstancedMesh>();
  private pickMaps = new Map<number, Entity[]>();
  private tmp = new THREE.Object3D();

  /** @param scene Added to directly — every `registerType()` mesh gets added here. */
  constructor(private scene: THREE.Scene) {}

  /** Creates and registers the `InstancedMesh` for a visual type id, sized for
   *  up to `capacity` simultaneous instances. Call once per type, up front. */
  registerType(
    typeId: number,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    this.meshes.set(typeId, mesh);
    this.pickMaps.set(typeId, []);
    this.scene.add(mesh);
    return mesh;
  }

  /** Write current transforms into instance buffers. `typeStore` maps entity -> typeId. */
  sync(transforms: TransformStore, typeStore: ArrayComponentStore<number>): void {
    for (const mesh of this.meshes.values()) mesh.count = 0;
    for (const list of this.pickMaps.values()) list.length = 0;

    const entities = transforms.entities;
    const raw = transforms.raw;
    const stride = transforms.stride;

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      const typeId = typeStore.get(e);
      if (typeId === undefined) continue;
      const mesh = this.meshes.get(typeId);
      if (mesh === undefined) continue;

      const o = i * stride;
      this.tmp.position.set(raw[o], raw[o + 1], raw[o + 2]);
      this.tmp.quaternion.set(raw[o + 3], raw[o + 4], raw[o + 5], raw[o + 6]);
      this.tmp.scale.set(raw[o + 7], raw[o + 8], raw[o + 9]);
      this.tmp.updateMatrix();

      const instanceIndex = mesh.count++;
      mesh.setMatrixAt(instanceIndex, this.tmp.matrix);
      this.pickMaps.get(typeId)![instanceIndex] = e;
    }

    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
  }

  /** The `InstancedMesh` registered for `typeId`, if any — e.g. for raycasting against it. */
  meshFor(typeId: number): THREE.InstancedMesh | undefined {
    return this.meshes.get(typeId);
  }

  /** Resolve a raycast hit (mesh + instanceId) back to the entity it drew this frame. */
  entityAt(typeId: number, instanceIndex: number): Entity | undefined {
    return this.pickMaps.get(typeId)?.[instanceIndex];
  }

  /**
   * Tints one entity's current-frame instance. `color` multiplies the mesh's
   * material color (so e.g. `new THREE.Color(1.4, 1.4, 1.4)` reads as "the
   * same color, but lighter" without the renderer needing to know each type's
   * base color) — pass `null` to reset to no tint. Must be called after
   * `sync()`, since it needs this frame's instanceIndex; a no-op if the
   * entity wasn't drawn under `typeId` this frame (wrong type, or despawned).
   */
  setInstanceColor(typeId: number, entity: Entity, color: THREE.Color | null): void {
    const mesh = this.meshes.get(typeId);
    const list = this.pickMaps.get(typeId);
    if (!mesh || !list) return;
    const index = list.indexOf(entity);
    if (index === -1) return;

    // Three.js zero-fills a freshly-allocated instanceColor buffer, so every
    // instance but the one just set would render black (0,0,0 multiplier)
    // until explicitly touched. Back-fill the rest to neutral on that first
    // allocation so setting one instance's color never darkens the others.
    const isNewBuffer = mesh.instanceColor === null;
    mesh.setColorAt(index, color ?? NEUTRAL_COLOR);
    if (isNewBuffer && mesh.instanceColor) {
      const arr = mesh.instanceColor.array as Float32Array;
      for (let i = 0; i < mesh.count; i++) {
        if (i === index) continue;
        arr[i * 3] = NEUTRAL_COLOR.r;
        arr[i * 3 + 1] = NEUTRAL_COLOR.g;
        arr[i * 3 + 2] = NEUTRAL_COLOR.b;
      }
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
}
