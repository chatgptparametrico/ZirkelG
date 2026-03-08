import * as THREE from 'three';

const CONFIG = {
    ringRadius: 40,
    tunnelSize: 6,
    tubeSegments: 300,
};

const offset = CONFIG.ringRadius * 0.8; 
const centers = [
    new THREE.Vector3(offset, 0, offset),
    new THREE.Vector3(-offset, 0, offset),
    new THREE.Vector3(-offset, 0, -offset),
    new THREE.Vector3(offset, 0, -offset)
];

const points = [];
const segments = 32;
for(let j=0; j<segments; j++) {
    const angle = (j / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(
        centers[0].x + Math.cos(angle) * CONFIG.ringRadius,
        0,
        centers[0].z + Math.sin(angle) * CONFIG.ringRadius
    ));
}

const curve = new THREE.CatmullRomCurve3(points);
curve.closed = true;

const tubeGeo = new THREE.TubeGeometry(curve, CONFIG.tubeSegments, CONFIG.tunnelSize / 2, 4, true);

tubeGeo.computeBoundingBox();
console.log("Vertices:", tubeGeo.attributes.position.count);
console.log("Bounding Box:", JSON.stringify(tubeGeo.boundingBox, null, 2));

const p0 = new THREE.Vector3();
p0.fromBufferAttribute(tubeGeo.attributes.position, 0);
console.log("Point 0:", p0);
