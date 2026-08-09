import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Thin cache over `GLTFLoader`: `load()` parses a .gltf/.glb once per URL and
 * hands every subsequent caller the same resolved `GLTF` (its promise, in
 * fact — concurrent callers before the first load finishes all await one
 * fetch/parse, not one each). `instantiate()` is the common case on top of
 * that — a fresh `Object3D` clone per call, so e.g. spawning a hundred
 * entities from one tree model parses the file once and clones the (cheap)
 * scene graph a hundred times.
 *
 * Because the cache key is the URL, only the *first* caller for a given URL
 * gets live `onProgress` callbacks — later callers resolve once that shared
 * promise settles, with no partial-progress reporting of their own. Fine for
 * the common case (one `Preloader` task per unique asset); if the same URL
 * needs progress reported to multiple independent listeners, track a `Set`
 * of callbacks per URL and fan out from the one underlying load instead.
 *
 * `.scene.clone(true)` is a plain `Object3D` deep clone — correct for static
 * props, not for skinned/animated meshes, which share bone bindings and need
 * `SkeletonUtils.clone` instead (three/examples/jsm/utils/SkeletonUtils.js).
 */
export class GltfLoader {
  private loader = new GLTFLoader();
  private cache = new Map<string, Promise<GLTF>>();

  /** Fetches and parses a .gltf/.glb, caching by `url`. `onProgress` (0..1,
   *  when the server reports a `Content-Length`) only fires for the call that
   *  actually triggers the fetch — see the class doc. */
  load(url: string, onProgress?: (fraction: number) => void): Promise<GLTF> {
    let cached = this.cache.get(url);
    if (!cached) {
      cached = new Promise<GLTF>((resolve, reject) => {
        this.loader.load(
          url,
          resolve,
          (event) => {
            if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total);
          },
          reject,
        );
      });
      this.cache.set(url, cached);
    }
    return cached;
  }

  /** `load()` plus a fresh `scene.clone(true)` — the usual way to get a
   *  placeable instance of a loaded model. See the class doc for the
   *  static-mesh-only caveat. */
  async instantiate(url: string, onProgress?: (fraction: number) => void): Promise<THREE.Object3D> {
    const gltf = await this.load(url, onProgress);
    return gltf.scene.clone(true);
  }
}
