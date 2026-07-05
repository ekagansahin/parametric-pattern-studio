// Three.js scene: model display, rotation, section (clipping) view.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clipConstant } from './clip.js';

export class Viewer {
  constructor(container) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161a);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.camera.position.set(120, 90, 120);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(1, 2, 1.5);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x8899bb, 0.5);
    dir2.position.set(-1.5, -0.5, -1);
    this.scene.add(dir2);

    this.grid = new THREE.GridHelper(200, 20, 0x2c313a, 0x22262d);
    this.scene.add(this.grid);

    // Clipping plane: normal -Y -> the area below the plane stays visible
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9);

    this.material = new THREE.MeshStandardMaterial({
      color: 0x7fa8e8,
      metalness: 0.05,
      roughness: 0.55,
      side: THREE.DoubleSide,
      clippingPlanes: [this.clipPlane]
    });

    this.group = new THREE.Group();
    this.group.rotation.x = -Math.PI / 2; // STL is mostly Z-up
    this.scene.add(this.group);
    this.mesh = null;
    this.bbox = new THREE.Box3();

    const resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    };
    window.addEventListener('resize', resize);
    resize();

    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  setMesh(vertProperties, triVerts) {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(vertProperties, 3));
    geo.setIndex(new THREE.BufferAttribute(triVerts, 1));
    geo.computeVertexNormals();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.group.add(this.mesh);

    this.bbox.setFromObject(this.group);
    this.setClip(this._clipPct ?? 100);
    this.fitCamera();
  }

  fitCamera() {
    const size = new THREE.Vector3(), center = new THREE.Vector3();
    this.bbox.getSize(size);
    this.bbox.getCenter(center);
    const radius = Math.max(size.x, size.y, size.z) * 0.75 || 50;
    this.controls.target.copy(center);
    const dirVec = new THREE.Vector3(1, 0.7, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dirVec, radius * 2.4);
    this.camera.near = radius / 100;
    this.camera.far = radius * 100;
    this.camera.updateProjectionMatrix();
  }

  /** Toggle flat shading (low-poly) view */
  setFlat(on) {
    this.material.flatShading = on;
    this.material.needsUpdate = true;
  }

  /** pct: 100 = model fully visible, 0 = fully clipped (Step 7 logic) */
  setClip(pct) {
    this._clipPct = pct;
    if (this.bbox.isEmpty()) return;
    this.clipPlane.constant = clipConstant(pct, this.bbox.min.y, this.bbox.max.y);
  }
}
