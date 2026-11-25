import * as T from 'three';
import type { CarId, LivePose } from '../multiplayer-poc/src/game.ts';
import type { Relay } from '../multiplayer-poc/src/protocol.ts';
import { vehicles } from './vehicle-registry.ts';
import { disposeVisual, type VehicleVisual } from './vehicle-visual.ts';

const delayMs = 150;
const extrapolateMs = 95;
const staleMs = 700;
type Sample = { time: number; packet: Relay; live: LivePose; position: T.Vector3; orientation: T.Quaternion };

export class RemoteCar {
  private visuals = new Map<CarId, Promise<VehicleVisual>>();
  private visual?: VehicleVisual;
  private selected?: CarId;
  private frames: Sample[] = [];
  private previous?: Sample;
  private position = new T.Vector3();
  private rotation = new T.Quaternion();
  private velocity = new T.Vector3();
  private source?: Relay;
  failed = false;

  constructor(private scene: T.Scene, private onLoad: () => void) {}

  get ready() { return Boolean(this.visual); }
  get visiblePosition() { return this.visual?.group.visible ? this.visual.group.position : undefined; }
  get stats() {
    return { model: this.selected, visible: Boolean(this.visiblePosition), received: this.source?.seq ?? 0,
      buffered: this.frames.length, progress: this.source?.live?.progress ?? 0 };
  }

  select(id?: CarId) {
    if (this.selected === id && !this.failed) return;
    this.visual?.group.removeFromParent();
    this.visual = undefined;
    this.selected = id;
    this.failed = false;
    this.clear();
    if (!id) return;
    const cache = this.visuals;
    let load = cache.get(id);
    if (!load) {
      load = vehicles[id].build().then(async visual => {
        try {
          await visual.load(true);
          visual.group.name = 'Remote ' + id.toUpperCase();
          visual.group.userData.remoteVehicle = id;
          visual.group.traverse(node => {
            if (!node.userData.shadowOnly) node.layers.enable(0);
          });
          return visual;
        } catch (error) {
          disposeVisual(visual);
          throw error;
        }
      });
      cache.set(id, load);
    }
    void load.then(visual => {
      if (cache !== this.visuals || id !== this.selected) return;
      visual.group.visible = false;
      this.visual = visual;
      this.scene.add(visual.group);
      this.onLoad();
    }, () => {
      if (cache.get(id) === load) cache.delete(id);
      if (cache !== this.visuals || id !== this.selected) return;
      this.failed = true;
      this.onLoad();
    });
  }

  receive(packet: Relay) {
    if (!packet.live) return;
    const last = this.previous;
    if (last?.packet.generation === packet.generation && packet.seq <= last.packet.seq) return;
    if (last && (last.live.reset !== packet.live.reset || last.packet.generation !== packet.generation ||
        packet.receivedAt - last.packet.receivedAt > staleMs)) this.clear();

    const position = new T.Vector3(...packet.position);
    if (this.previous && position.distanceToSquared(this.previous.position) > 60 ** 2) this.clear();
    const time = Math.min(packet.receivedAt + 15, Math.max(packet.receivedAt - 1_000, packet.t));
    const sample = {
      time: Math.max((this.previous?.time ?? 0) + .01, time),
      packet, live: packet.live, position,
      orientation: new T.Quaternion(...packet.orientation).normalize(),
    };
    this.previous = sample;
    this.source = packet;
    this.frames.push(sample);
    if (this.frames.length > 32) this.frames.shift();
  }

  draw(serverNow: number, dt: number) {
    const visual = this.visual;
    if (!visual) return;
    const target = serverNow - delayMs;
    const last = this.frames.at(-1);
    if (!last || this.frames.length < 2 || serverNow - last.packet.receivedAt > staleMs) {
      visual.group.visible = false;
      return;
    }
    while (this.frames.length > 2 && this.frames[1].time <= target) this.frames.shift();
    const a = this.frames[0], b = this.frames[1];
    const ratio = T.MathUtils.clamp((target - a.time) / (b.time - a.time), 0, 1);
    this.position.lerpVectors(a.position, b.position, ratio);
    this.rotation.slerpQuaternions(a.orientation, b.orientation, ratio);
    if (target > b.time) {
      this.velocity.set(...b.packet.velocity).multiplyScalar(Math.min(target - b.time, extrapolateMs) / 1000).clampLength(0, 6);
      this.position.add(this.velocity);
    }
    visual.group.visible = true;
    visual.group.position.copy(this.position);
    visual.group.quaternion.copy(this.rotation);
    const spec = vehicles[this.selected!].spec;
    visual.wheels.forEach(({pivot, roller}, i) => {
      pivot.position.y = spec.mountHeight - T.MathUtils.lerp(a.live.suspension[i], b.live.suspension[i], ratio);
      if (i < 2) pivot.rotation.y = T.MathUtils.lerp(a.live.steering[i], b.live.steering[i], ratio);
      roller.rotation.x = -T.MathUtils.lerp(a.live.wheels[i], b.live.wheels[i], ratio);
    });
    visual.syncExteriorLights(ratio < .5 ? a.live.flags : b.live.flags, dt);
  }

  clear() {
    this.frames.length = 0;
    this.previous = undefined;
    this.source = undefined;
    if (this.visual) this.visual.group.visible = false;
  }

  dispose() {
    this.select(undefined);
    for (const promise of this.visuals.values()) void promise.then(disposeVisual, () => {});
    this.visuals = new Map();
  }
}
