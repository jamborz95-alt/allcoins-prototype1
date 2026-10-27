// Mobile-first realtime 3D drag strip. Three.js is loaded dynamically so the game
// can show a clear fallback instead of breaking the controls if the CDN is unavailable.
(async function initDragRacing3D(){
  const host = document.getElementById("scene");
  const canvas = document.getElementById("race3dCanvas");
  if (!host || !canvas) return;
  let THREE;
  try {
    THREE = await import("https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js");
  } catch (error) {
    const note = document.createElement("div");
    note.className = "scene3d-warning";
    note.textContent = "3D-сцена не загрузилась. Проверь интернет-соединение и обнови игру.";
    host.appendChild(note);
    return;
  }
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: (window.devicePixelRatio || 1) <= 1.25,
      alpha: false,
      powerPreference: "low-power"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setSize(host.clientWidth, host.clientHeight, false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x91b5cf);
    scene.fog = new THREE.Fog(0x91b5cf, 55, 235);

    const camera = new THREE.PerspectiveCamera(53, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 300);
    camera.position.set(0, 4.0, 10.5);
    camera.lookAt(0, 0.7, -17);

    scene.add(new THREE.HemisphereLight(0xe6f4ff, 0x33343c, 2.1));
    const sun = new THREE.DirectionalLight(0xffe5bd, 3.0);
    sun.position.set(-18, 27, 10);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x6da8ff, 1.05);
    fill.position.set(12, 8, -24);
    scene.add(fill);

    const mat = (color, roughness=0.75, metalness=0) => new THREE.MeshStandardMaterial({color,roughness,metalness});
    const roadMat = new THREE.MeshStandardMaterial({color:0x252c35,roughness:0.94,metalness:0.02});
    const white = mat(0xf4f0df,0.5);
    const red = mat(0xe52e3d,0.3,0.32);
    const dark = mat(0x10151c,0.4,0.1);
    const glass = new THREE.MeshPhysicalMaterial({color:0x172b40,roughness:0.18,metalness:0.28,clearcoat:0.7,transparent:true,opacity:0.93});
    const rubber = mat(0x080b10,0.92);
    const rim = mat(0xb6c5d1,0.26,0.8);
    const tail = new THREE.MeshStandardMaterial({color:0xff1738,emissive:0x790013,emissiveIntensity:2.1,roughness:0.25});
    const head = new THREE.MeshStandardMaterial({color:0xfff0be,emissive:0xffb84b,emissiveIntensity:1.6});
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(260,520),mat(0x3c5149,1));
    ground.rotation.x=-Math.PI/2;ground.position.set(0,-0.17,-225);scene.add(ground);
    const road = new THREE.Mesh(new THREE.PlaneGeometry(13,520),roadMat);
    road.rotation.x=-Math.PI/2;road.position.set(0,-0.08,-225);scene.add(road);

    const markings=[];
    for(let lane=-1;lane<=1;lane++){
      for(let i=0;i<31;i++){
        const marker=new THREE.Mesh(new THREE.BoxGeometry(lane===0?0.11:0.075,0.018,4.1),white);
        marker.position.set(lane*2.25,-0.055,-265+i*9);
        marker.userData.baseZ=marker.position.z;
        scene.add(marker);markings.push(marker);
      }
    }
    const curbs=[];
    for(const side of [-1,1]){
      const rail=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.38,520),mat(0x68717c,0.65,0.2));
      rail.position.set(side*6.35,0.12,-225);scene.add(rail);
      for(let i=0;i<65;i++){
        const stripe=new THREE.Mesh(new THREE.BoxGeometry(0.235,0.4,3.3),mat(i%2?0xf3eee1:0xb52332,0.75));
        stripe.position.set(side*6.35,0.13,-485+i*8);
        stripe.userData.baseZ=stripe.position.z;
        scene.add(stripe);curbs.push(stripe);
      }
    }

    const buildings=[];
    const buildingMats=[0x344351,0x46515d,0x394958,0x58606a,0x2d3b48].map(c=>mat(c,0.91));
    const windowMat=new THREE.MeshStandardMaterial({color:0xffd99a,emissive:0x825c31,emissiveIntensity:0.18,roughness:0.5});
    for(let side of [-1,1]){
      for(let i=0;i<19;i++){
        const width=2.2+(i%4)*0.55, depth=3+(i%3)*1.2, height=5+(i%7)*2.1;
        const building=new THREE.Mesh(new THREE.BoxGeometry(width,height,depth),buildingMats[(i+(side===1?2:0))%buildingMats.length]);
        building.position.set(side*(9.8+(i%3)*1.7),height/2-0.1,-240+i*14);
        building.userData.baseZ=building.position.z;
        scene.add(building);buildings.push(building);
        const windowStrip=new THREE.Mesh(new THREE.BoxGeometry(width*0.74,0.17,0.035),windowMat);
        windowStrip.position.set(building.position.x,height*0.57-0.1,building.position.z+(side===1?depth/2:-depth/2));
        windowStrip.userData.baseZ=windowStrip.position.z;
        scene.add(windowStrip);buildings.push(windowStrip);
      }
    }

    const lamps=[];
    const lampMetal=mat(0x5e6b79,0.42,0.72);
    const lampGlow=new THREE.MeshStandardMaterial({color:0xffe7ba,emissive:0xffd08a,emissiveIntensity:1.5});
    for(const side of [-1,1]){
      for(let i=0;i<12;i++){
        const z=-225+i*23;
        const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.045,0.07,5.5,7),lampMetal);
        pole.position.set(side*7.5,2.7,z);
        pole.userData.baseZ=z;scene.add(pole);lamps.push(pole);
        const arm=new THREE.Mesh(new THREE.BoxGeometry(0.85,0.055,0.06),lampMetal);
        arm.position.set(side*7.15,5.25,z);arm.userData.baseZ=z;scene.add(arm);lamps.push(arm);
        const bulb=new THREE.Mesh(new THREE.BoxGeometry(0.48,0.13,0.25),lampGlow);
        bulb.position.set(side*6.8,5.15,z);bulb.userData.baseZ=z;scene.add(bulb);lamps.push(bulb);
      }
    }

    // Detailed procedural VAZ-inspired sport sedan model, assembled from 3D meshes.
    const car=new THREE.Group();
    car.position.set(0,-0.07,2.6);scene.add(car);
    const addBox=(parent,geometry,material,x,y,z)=>{const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);parent.add(mesh);return mesh;};
    addBox(car,new THREE.BoxGeometry(1.78,0.42,3.35),red,0,0.57,0);
    addBox(car,new THREE.BoxGeometry(1.68,0.26,1.23),red,0,0.78,-0.91);
    addBox(car,new THREE.BoxGeometry(1.62,0.24,0.78),red,0,0.78,1.18);
    addBox(car,new THREE.BoxGeometry(1.35,0.48,1.38),red,0,0.98,0.13);
    addBox(car,new THREE.BoxGeometry(1.25,0.34,1.13),glass,0,1.02,0.11);
    addBox(car,new THREE.BoxGeometry(1.32,0.055,0.88),dark,0,0.705,0.42);
    addBox(car,new THREE.BoxGeometry(1.87,0.14,0.19),dark,0,0.46,1.63);
    addBox(car,new THREE.BoxGeometry(1.68,0.08,0.17),mat(0xd5d9de,0.3,0.85),0,0.52,1.75);
    addBox(car,new THREE.BoxGeometry(1.76,0.12,0.13),dark,0,0.69,-1.68);
    addBox(car,new THREE.BoxGeometry(1.84,0.075,0.15),mat(0xf3c96c,0.25,0.65),0,0.66,-1.61);
    for(const x of [-0.83,0.83]){
      addBox(car,new THREE.BoxGeometry(0.035,0.25,0.72),dark,x,0.98,-0.08);
      const mirror=addBox(car,new THREE.BoxGeometry(0.19,0.12,0.17),red,x*1.18,0.86,-0.47);
      mirror.rotation.y=x<0?-0.12:0.12;
      addBox(car,new THREE.BoxGeometry(0.12,0.18,0.07),tail,x*0.69,0.69,1.705);
      addBox(car,new THREE.BoxGeometry(0.14,0.1,0.045),head,x*0.68,0.69,-1.72);
      for(const z of [-1.12,1.1]){
        const wheel=new THREE.Group();wheel.position.set(x,0.38,z);car.add(wheel);
        const tire=new THREE.Mesh(new THREE.CylinderGeometry(0.39,0.39,0.21,20),rubber);tire.rotation.z=Math.PI/2;wheel.add(tire);
        const hub=new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.2,0.224,12),rim);hub.rotation.z=Math.PI/2;wheel.add(hub);
        const center=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,0.23,10),dark);center.rotation.z=Math.PI/2;wheel.add(center);
        wheel.userData.rotating=true;
      }
    }
    // Rear spoiler and a pair of exhaust tips add a visible drag-build silhouette.
    addBox(car,new THREE.BoxGeometry(1.35,0.055,0.23),dark,0,1.18,1.41);
    for(const x of [-0.47,0.47]){
      const pipe=new THREE.Mesh(new THREE.CylinderGeometry(0.075,0.075,0.18,10),rim);
      pipe.rotation.x=Math.PI/2;pipe.position.set(x,0.49,1.78);car.add(pipe);
    }

    let progress=0, previous=performance.now();
    const resize=()=>{
      const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight);
      camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h,false);
    };
    const mod=(v,m)=>((v%m)+m)%m;
    const animate=now=>{
      requestAnimationFrame(animate);
      const dt=Math.min(0.05,Math.max(0,(now-previous)/1000));previous=now;
      const speed=Number(document.getElementById("speed")?.textContent||0);
      const running=host.classList.contains("racing");
      progress+=speed/3.6*dt*(running?1.35:0.12);
      for(const mesh of markings){mesh.position.z=mod(mesh.userData.baseZ+progress+265,270)-265;}
      for(const mesh of curbs){mesh.position.z=mod(mesh.userData.baseZ+progress+485,520)-485;}
      for(const mesh of buildings){mesh.position.z=mod(mesh.userData.baseZ+progress+240,280)-240;}
      for(const mesh of lamps){mesh.position.z=mod(mesh.userData.baseZ+progress+225,276)-225;}
      const factor=Math.min(1,speed/210);
      car.rotation.y=Math.sin(now*0.0013)*0.014*factor;
      car.position.y=-0.07+(running?Math.abs(Math.sin(now*0.024))*0.012*factor:0);
      car.traverse(node=>{
        if(node.userData.rotating){node.children.forEach(child=>{child.rotation.x+=speed*dt*0.0017;});}
      });
      camera.position.x=Math.sin(now*0.0008)*0.045*factor;
      camera.position.y=4.0+Math.sin(now*0.018)*0.018*factor;
      camera.lookAt(0,0.75,-17);
      renderer.render(scene,camera);
    };
    if("ResizeObserver" in window) new ResizeObserver(resize).observe(host); else window.addEventListener("resize",resize);
    resize();requestAnimationFrame(animate);
    host.classList.add("has3d");
  } catch (error) {
    const note = document.createElement("div");
    note.className = "scene3d-warning";
    note.textContent = "Не удалось запустить 3D на этом устройстве. Перезагрузи игру.";
    host.appendChild(note);
  }
})();