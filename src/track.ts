import {CatmullRomCurve3,Vector3,MathUtils} from 'three';

// Survey points [easting, north/south, elevation]. Scale in metres, pit straight at datum.
const survey=[
  [-110,320,1.6],[-110,260,1.6],[-110,180,1.6],[-110,80,1.6],
  [-110,-40,2.4],[-110,-135,3.9],[-127,-201,7],[-178,-245,12],
  [-256,-258,18],[-329,-249,24],[-407,-274,31],[-477,-335,37],
  [-513,-354,41],[-560,-354,45],[-611,-390,48],[-640,-462,54],
  [-634,-536,61],[-590,-605,67],[-505,-655,73],[-378,-685,79],
  [-259,-692,85],[-183,-678,90],[-141,-652,92],[-126,-625,92],
  [-134,-602,91],[-158,-587,90],[-201,-590,86],[-260,-601,82],
  [-305,-583,78],[-322,-543,74],[-300,-503,70],[-250,-486,66],
  [-196,-496,62],[-132,-532,57],[-62,-556,53],[30,-556,49],
  [184,-556,45],[305,-548,42],[383,-515,41],[427,-452,40],
  [435,-374,39],[410,-300,38],[348,-237,37],[274,-190,34],
  [239,-144,31],[222,-78,28],[230,-9,26],[265,62,24],
  [327,112,21],[413,134,17],[506,131,14],[574,151,13],
  [611,197,12],[607,249,11],[550,289,10],[479,298,10],
  [399,277,12],[349,278,15],[321,309,18],[318,364,21],
  [305,407,21],[267,432,18],[203,427,15],[115,387,12],
  [69,390,10],[45,422,8],[27,465,7],[-14,494,5],
  [-66,484,3],[-100,451,2],[-110,396,1.6],
];
export const roadHalfWidth=5.6,railOffset=7.25;
export const course=new CatmullRomCurve3(survey.map(([x,z,y])=>new Vector3(x,y,z)),true);
course.arcLengthDivisions=survey.length*256;
export const courseLength=course.getLength();
const arcTable=course.getLengths();
export const surveyMeters=survey.map((_,i)=>arcTable[i*256]);
export const lineDistance=surveyMeters[2];
export function sampleAt(d:number){
  const distance=MathUtils.euclideanModulo(d,courseLength),t=distance/courseLength;
  const p=course.getPointAt(t),forward=course.getTangentAt(t);
  const past=course.getTangentAt(MathUtils.euclideanModulo(distance-4,courseLength)/courseLength);
  const next=course.getTangentAt(MathUtils.euclideanModulo(distance+4,courseLength)/courseLength);
  const right=new Vector3(-forward.z,0,forward.x).normalize();
  const curvature=right.dot(next.sub(past))/8;
  right.y=-MathUtils.clamp(curvature*2.1,-.052,.052);right.normalize();
  return {p,right,forward,curvature,distance:d};
}
const count=Math.ceil(courseLength/2.15);
export const stations=Array.from({length:count+1},(_,i)=>sampleAt(i*courseLength/count));
export type Station=typeof stations[number];
export const startLine=sampleAt(lineDistance);
const gridStation=sampleAt(lineDistance-58);
export const grid=gridStation.p.clone().addScaledVector(gridStation.right,1.85);
export const oppositeGrid=gridStation.p.clone().addScaledVector(gridStation.right,-1.85);
const yaw=Math.atan2(-gridStation.forward.x,-gridStation.forward.z);
export const gridRotation={x:0,y:Math.sin(yaw/2),z:0,w:Math.cos(yaw/2)};

// Exact 2D nearest station with branch-and-bound. Used by the terrain and forest as well as the HUD.
type Branch={i:number;xAxis:boolean;lo?:Branch;hi?:Branch};
function spatialIndex(ids:number[],xAxis:boolean):Branch|undefined{
  if(!ids.length)return;
  const coord=xAxis?'x':'z';ids.sort((a,b)=>stations[a].p[coord]-stations[b].p[coord]);
  const mid=Math.floor(ids.length/2);
  return {i:ids[mid],xAxis,lo:spatialIndex(ids.slice(0,mid),!xAxis),hi:spatialIndex(ids.slice(mid+1),!xAxis)};
}
const tree=spatialIndex(Array.from({length:count},(_,i)=>i),true);
export function nearestStation(x:number,z:number){
  let index=0,best=Infinity;
  function visit(t?:Branch){
    if(!t)return;
    const p=stations[t.i].p,dx=x-p.x,dz=z-p.z,d=dx*dx+dz*dz;
    if(d<best){best=d;index=t.i;}
    const split=t.xAxis?dx:dz;visit(split<0?t.lo:t.hi);
    if(split*split<best)visit(split<0?t.hi:t.lo);
  }
  visit(tree);return {index,distance:Math.sqrt(best)};
}
export const onBridge=(s:Station)=>s.distance>=surveyMeters[45]-10&&s.distance<=surveyMeters[47]+22;
// Sample a smooth ridge field across adjacent switchbacks. Nearest-road elevation
// alone jumps at the watershed between two roads at different elevations.
const ridgeHeights=new Map<string,number>();
const terrainSamples=stations.filter((_,i)=>i%16===0);
function ridgeHeight(gx:number,gz:number){
  const key=gx+','+gz;
  const cached=ridgeHeights.get(key);if(cached!==undefined)return cached;
  let sum=0,weight=0;
  for(const sample of terrainSamples){
    const d2=(sample.p.x-gx*32)**2+(sample.p.z-gz*32)**2;
    const w=1/(d2+400)**1.8;sum+=sample.p.y*w;weight+=w;
  }
  const value=sum/weight;ridgeHeights.set(key,value);return value;
}
export function terrainY(x:number,z:number){
  const {index,distance}=nearestStation(x,z),s=stations[index];
  const outside=10+14*Math.sin(x*.009)+12*Math.cos(z*.008+x*.004)+6*Math.sin(x*.031-z*.019);
  const ridge=33*Math.exp(-((x+535)**2+(z+480)**2)/68000)+22*Math.exp(-((x-660)**2+(z-330)**2)/44000);
  const blend=1-MathUtils.smoothstep(distance,17,230);
  const valley=18*Math.exp(-((z+10)**2)/4800-((x-239)**2)/4600);
  const gx=Math.floor(x/32),gz=Math.floor(z/32),u=x/32-gx,v=z/32-gz;
  const nearby=MathUtils.lerp(MathUtils.lerp(ridgeHeight(gx,gz),ridgeHeight(gx+1,gz),u),
    MathUtils.lerp(ridgeHeight(gx,gz+1),ridgeHeight(gx+1,gz+1),u),v);
  const shoulder=MathUtils.lerp(s.p.y,nearby,MathUtils.smoothstep(distance,16,36))-2.7+.38*Math.sin(z*.075)+.27*Math.cos(x*.094)-valley;
  return MathUtils.lerp(outside+ridge,shoulder,blend);
}
export function roadRipple(s:Station,x:number){
  const a=s.distance/courseLength*2*Math.PI;
  return .0055*Math.sin(307*a+.19*x)+.0033*Math.sin(457*a-.26*x)+.003*Math.sin(151*a+.11*x);
}
export function section(i:number){
  const s=stations[i],d=s.distance;
  if(onBridge(s))return 'Ravine viaduct';
  const boundaries:[number,string][]=[[5,'Main straight'],[7,'Braking straight'],[16,'Larch ascent'],[21,'North ridge'],[27,'Summit hairpin'],[34,'Downhill esses'],[38,'Plateau straight'],[44,'East sweeper'],[49,'Ravine approach'],[56,'Valley carousel'],[63,'Crest complex'],[70,'West switchback']];
  return boundaries.find(([k])=>d<surveyMeters[k])?.[1]??'Main straight';
}
