import * as T from 'three';
import type {CarVisual} from './car-visual.ts';
import type {Switch} from './f40-cabin.ts';
import {isSharedCabinTexture} from './finishes.ts';

export type VehicleVisual = Pick<CarVisual,
  'group'|'eye'|'hood'|'hitTargets'|'wheels'|'mirrors'|'driver'|'steering'|'instrumentBrightness'|'hit'|'sync'|'load'|'syncExteriorLights'
> & {
  popups:{requested:boolean;step(dt:number):void;sync(alpha:number):void;reset():void};
  readonly studioLighting?:boolean;
  controlHint?(action:Switch):string|undefined;
  animateControl?(action:Switch):void;
};

export function disposeVisual(visual:VehicleVisual){
  visual.group.removeFromParent();
  const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>(),textures=new Set<T.Texture>();
  visual.group.traverse(node=>{
    if(node instanceof T.SkinnedMesh)node.skeleton.dispose();
    if(node instanceof T.InstancedMesh)node.dispose();
    if(node instanceof T.Mesh){
      geometries.add(node.geometry);
      for(const material of [node.material].flat())materials.add(material);
    }
  });
  for(const material of materials){
    const values=Object.values(material);
    if(material instanceof T.ShaderMaterial)values.push(...Object.values(material.uniforms).map(uniform=>uniform.value));
    for(const value of values)if(value instanceof T.Texture && !value.isRenderTargetTexture && !isSharedCabinTexture(value))textures.add(value);
    material.dispose();
  }
  const images=new Set<ImageBitmap>();
  for(const texture of textures){
    if(typeof ImageBitmap!=='undefined'&&texture.image instanceof ImageBitmap)images.add(texture.image);
    texture.dispose();
  }
  for(const image of images)image.close();
  for(const geometry of geometries)geometry.dispose();
  visual.mirrors.dispose();
}
