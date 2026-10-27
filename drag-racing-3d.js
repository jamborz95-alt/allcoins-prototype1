// Mobile-first realtime 3D drag strip. Three.js is loaded dynamically so the game
// can show a clear fallback instead of breaking the controls if the CDN is unavailable.
(async function initDragRacing3D(){
  const host = document.getElementById("scene");
  const canvas = document.getElementById("race3dCanvas");
  if (!host || !canvas) return;
  let THREE;
  try {
    THREE = await import("https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js");
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
    const roadCanvas=document.createElement("canvas");
    roadCanvas.width=256;roadCanvas.height=256;
    const roadContext=roadCanvas.getContext("2d");
    roadContext.fillStyle="#2b3038";roadContext.fillRect(0,0,256,256);
    for(let n=0;n<850;n++){
      const shade=36+Math.floor(Math.random()*20);
      roadContext.fillStyle="rgba("+shade+","+shade+","+shade+","+(0.08+Math.random()*0.12)+")";
      roadContext.fillRect(Math.random()*256,Math.random()*256,1+Math.random()*3,1+Math.random()*2);
    }
    for(const laneX of [83,128,173]){
      for(let y=0;y<256;y+=48){
        roadContext.fillStyle=laneX===128?"#eee6d3":"#cdd1d4";
        roadContext.fillRect(laneX-1.5,y,3,23);
      }
    }
    const roadTexture=new THREE.CanvasTexture(roadCanvas);
    roadTexture.wrapS=THREE.RepeatWrapping;roadTexture.wrapT=THREE.RepeatWrapping;
    roadTexture.repeat.set(1,40);roadTexture.colorSpace=THREE.SRGBColorSpace;
    const roadMat = new THREE.MeshStandardMaterial({map:roadTexture,color:0xffffff,roughness:0.94,metalness:0.02});
    const curbCanvas=document.createElement("canvas");
    curbCanvas.width=64;curbCanvas.height=128;
    const curbContext=curbCanvas.getContext("2d");
    for(let y=0;y<128;y+=32){
      curbContext.fillStyle=(y/32)%2===0?"#e4e4df":"#c22635";
      curbContext.fillRect(0,y,64,32);
    }
    const curbTexture=new THREE.CanvasTexture(curbCanvas);
    curbTexture.wrapS=THREE.RepeatWrapping;curbTexture.wrapT=THREE.RepeatWrapping;
    curbTexture.repeat.set(1,65);curbTexture.colorSpace=THREE.SRGBColorSpace;
    const curbMaterial=new THREE.MeshStandardMaterial({map:curbTexture,roughness:0.82});
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

    // Lane dashes and red/white curbs are textures, not hundreds of meshes.
    // This cuts draw calls significantly on entry-level Android phones.
    for(const side of [-1,1]){
      const rail=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.38,520),curbMaterial);
      rail.position.set(side*6.35,0.12,-225);
      scene.add(rail);
    }

    const buildings=[];
    const buildingMats=[0x344351,0x46515d,0x394958,0x58606a,0x2d3b48].map(c=>mat(c,0.91));
    const windowMat=new THREE.MeshStandardMaterial({color:0xffd99a,emissive:0x825c31,emissiveIntensity:0.18,roughness:0.5});
    for(let side of [-1,1]){
      for(let i=0;i<13;i++){
        const width=2.2+(i%4)*0.55, depth=3+(i%3)*1.2, height=5+(i%7)*2.1;
        const building=new THREE.Mesh(new THREE.BoxGeometry(width,height,depth),buildingMats[(i+(side===1?2:0))%buildingMats.length]);
        building.position.set(side*(9.8+(i%3)*1.7),height/2-0.1,-240+i*21);
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
      for(let i=0;i<7;i++){
        const z=-225+i*38;
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
    // Beveled low-poly body hull follows a sedan's nose, hood, cabin and rear quarter.
    function makeSedanBody(){
      const stations=[
        [-1.79,0.72,0.43,0.63],[-1.62,0.84,0.39,0.76],
        [-1.25,0.89,0.36,0.79],[-0.82,0.85,0.36,0.78],
        [-0.36,0.81,0.36,0.73],[0.52,0.81,0.36,0.73],
        [0.96,0.86,0.37,0.77],[1.38,0.85,0.40,0.71],
        [1.74,0.74,0.43,0.62]
      ];
      const vertices=[];
      for(const [z,width,bottom,top] of stations){
        vertices.push(-width,bottom,z, width,bottom,z, -width,top,z, width,top,z);
      }
      const indices=[];
      for(let i=0;i<stations.length-1;i++){
        const a=i*4,b=(i+1)*4;
        // left skin, right skin, hood/roofline skin and underbody
        indices.push(a,a+2,b+2,a,b+2,b);
        indices.push(a+1,b+1,b+3,a+1,b+3,a+3);
        indices.push(a+2,a+3,b+3,a+2,b+3,b+2);
        indices.push(a,b,b+1,a,b+1,a+1);
      }
      indices.push(0,1,3,0,3,2);
      const last=(stations.length-1)*4;
      indices.push(last,last+2,last+3,last,last+3,last+1);
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute("position",new THREE.Float32BufferAttribute(vertices,3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      geometry.computeBoundingSphere();
      return geometry;
    }
    const bodyMesh=new THREE.Mesh(makeSedanBody(),red);
    bodyMesh.name="sedan-body";car.add(bodyMesh);
    const hood=addBox(car,new THREE.BoxGeometry(1.55,0.105,0.91),red,0,0.755,-1.02);
    hood.rotation.x=-0.025;
    const trunk=addBox(car,new THREE.BoxGeometry(1.52,0.105,0.58),red,0,0.755,1.22);
    trunk.rotation.x=0.018;
    const roofMesh=addBox(car,new THREE.BoxGeometry(1.35,0.48,1.38),red,0,0.98,0.13);
    roofMesh.name="drag-car-roof";
    const roofGlassMesh=addBox(car,new THREE.BoxGeometry(1.25,0.34,1.13),glass,0,1.02,0.11);
    roofGlassMesh.name="drag-car-roof-glass";
    addBox(car,new THREE.BoxGeometry(1.28,0.045,0.075),dark,0,0.56,-1.79);
    addBox(car,new THREE.BoxGeometry(0.52,0.18,0.08),mat(0x171b22,0.4,0.25),0,0.54,-1.805);
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
    // Each owned VAZ/LADA has its own paint and proportions in the 3D garage preview.
    const baseRoofGeometry=new THREE.BoxGeometry(1.35,0.48,1.38);
    const baseGlassGeometry=new THREE.BoxGeometry(1.25,0.34,1.13);
    const carVariants={
      "2104":{paint:0xd7dce2,x:1.02,z:1.04,roof:"wagon"},
      "2105":{paint:0x254c72,x:0.99,z:0.99},
      "2106":{paint:0x8f2936,x:1.01,z:1.02},
      "2107":{paint:0xe52e3d,x:1.0,z:1.0},
      "2109":{paint:0x24486f,x:0.95,z:0.93,roof:"hatch"},
      "2110":{paint:0xd9dde0,x:1.0,z:1.01},
      "2112":{paint:0xe2bd3d,x:0.97,z:0.94,roof:"hatch"},
      "2114":{paint:0x2773a2,x:0.96,z:0.94,roof:"hatch"},
      "priora":{paint:0x20262d,x:1.0,z:1.0},
      "granta":{paint:0xaebdc8,x:1.0,z:1.0},
      "niva":{paint:0x637650,x:1.07,z:1.07,roof:"suv"},
      "vesta":{paint:0xf1f1e8,x:1.03,z:1.03}
    };
    // Resolve named meshes instead of child indices: the detailed body adds meshes before the cabin.
    const roofMesh=car.getObjectByName("drag-car-roof");
    const roofGlassMesh=car.getObjectByName("drag-car-roof-glass");
    function applyCarVariant(carId){
      const model=carVariants[String(carId)]||carVariants["2107"];
      red.color.setHex(model.paint);
      car.scale.set(model.x,1,model.z);
      roofMesh.geometry.dispose();roofGlassMesh.geometry.dispose();
      roofMesh.geometry=baseRoofGeometry.clone();
      roofGlassMesh.geometry=baseGlassGeometry.clone();
      roofMesh.position.set(0,0.98,0.13);
      roofGlassMesh.position.set(0,1.02,0.11);
      if(model.roof==="wagon"){
        roofMesh.geometry.dispose();roofMesh.geometry=new THREE.BoxGeometry(1.35,0.49,1.7);
        roofGlassMesh.geometry.dispose();roofGlassMesh.geometry=new THREE.BoxGeometry(1.25,0.34,1.43);
        roofMesh.position.set(0,1.0,0.29);roofGlassMesh.position.set(0,1.04,0.25);
      } else if(model.roof==="hatch"){
        roofMesh.geometry.dispose();roofMesh.geometry=new THREE.BoxGeometry(1.34,0.44,1.16);
        roofGlassMesh.geometry.dispose();roofGlassMesh.geometry=new THREE.BoxGeometry(1.24,0.29,0.91);
        roofMesh.position.set(0,0.95,0.03);roofGlassMesh.position.set(0,0.99,0.02);
      } else if(model.roof==="suv"){
        roofMesh.geometry.dispose();roofMesh.geometry=new THREE.BoxGeometry(1.42,0.58,1.42);
        roofGlassMesh.geometry.dispose();roofGlassMesh.geometry=new THREE.BoxGeometry(1.3,0.42,1.15);
        roofMesh.position.set(0,1.04,0.13);roofGlassMesh.position.set(0,1.08,0.11);
      }
    }
    window.addEventListener("allcoins:car-selected",event=>applyCarVariant(event.detail?.carId));
    applyCarVariant(window.__allcoinsDragRacingCarId||"2107");

    // Door seams and side skirts create more definition in the moving body.
    for(const side of [-1,1]){
      const doorLine=addBox(car,new THREE.BoxGeometry(0.012,0.23,0.58),dark,side*0.814,0.61,-0.04);
      doorLine.rotation.y=side<0?-0.025:0.025;
      addBox(car,new THREE.BoxGeometry(0.065,0.055,0.54),dark,side*0.842,0.43,0.15);
      addBox(car,new THREE.BoxGeometry(0.21,0.035,0.045),mat(0xb9c5ce,0.28,0.72),side*0.57,0.72,-1.735);
      addBox(car,new THREE.BoxGeometry(0.18,0.035,0.035),tail,side*0.58,0.7,1.76);
      // A small turn-signal lens on each front corner catches the key light.
      addBox(car,new THREE.BoxGeometry(0.08,0.035,0.035),mat(0xffb34d,0.3),side*0.76,0.63,-1.77);
    }
    // Rear spoiler and a pair of exhaust tips add a visible drag-build silhouette.
    addBox(car,new THREE.BoxGeometry(1.35,0.055,0.23),dark,0,1.18,1.41);
    for(const x of [-0.47,0.47]){
      const pipe=new THREE.Mesh(new THREE.CylinderGeometry(0.075,0.075,0.18,10),rim);
      pipe.rotation.x=Math.PI/2;pipe.position.set(x,0.49,1.78);car.add(pipe);
    }

    const opponentCars=new Map();
    let raceState={room:null,players:[]};
    const paintByCar={"2104":0xd7dce2,"2105":0x254c72,"2106":0x8f2936,"2107":0xe52e3d,"2109":0x24486f,"2110":0xd9dde0,"2112":0xe2bd3d,"2114":0x2773a2,"priora":0x20262d,"granta":0xaebdc8,"niva":0x637650,"vesta":0xf1f1e8};
    const scaleByCar={"2104":[1.02,1.04],"2105":[0.99,0.99],"2106":[1.01,1.02],"2107":[1,1],"2109":[0.95,0.93],"2110":[1,1.01],"2112":[0.97,0.94],"2114":[0.96,0.94],"priora":[1,1],"granta":[1,1],"niva":[1.07,1.07],"vesta":[1.03,1.03]};
    function setRaceState(detail){
      raceState=detail||{room:null,players:[]};
      const players=Array.isArray(raceState.players)?raceState.players:[];
      const ids=new Set(players.filter(p=>!p.isMe).map(p=>String(p.id)));
      for(const [id,model] of opponentCars){
        if(!ids.has(id)){scene.remove(model);opponentCars.delete(id);}
      }
      for(const p of players){
        const id=String(p.id);
        if(p.isMe||opponentCars.has(id))continue;
        const model=car.clone(true);
        model.traverse(node=>{
          if(!node.isMesh)return;
          if(node.material===red){
            node.material=red.clone();
            node.material.color.setHex(paintByCar[p.car_id]||0xe52e3d);
          }
        });
        const spec=carVariants[String(p.car_id)]||carVariants["2107"];
        const roof=model.getObjectByName("drag-car-roof"), windshield=model.getObjectByName("drag-car-roof-glass");
        if(!roof||!windshield)throw new Error("Opponent car roof meshes missing");
        roof.geometry=baseRoofGeometry.clone();
        windshield.geometry=baseGlassGeometry.clone();
        roof.position.set(0,0.98,0.13);
        windshield.position.set(0,1.02,0.11);
        if(spec.roof==="wagon"){
          roof.geometry=new THREE.BoxGeometry(1.35,0.49,1.7);
          windshield.geometry=new THREE.BoxGeometry(1.25,0.34,1.43);
          roof.position.set(0,1.0,0.29);windshield.position.set(0,1.04,0.25);
        }else if(spec.roof==="hatch"){
          roof.geometry=new THREE.BoxGeometry(1.34,0.44,1.16);
          windshield.geometry=new THREE.BoxGeometry(1.24,0.29,0.91);
          roof.position.set(0,0.95,0.03);windshield.position.set(0,0.99,0.02);
        }else if(spec.roof==="suv"){
          roof.geometry=new THREE.BoxGeometry(1.42,0.58,1.42);
          windshield.geometry=new THREE.BoxGeometry(1.3,0.42,1.15);
          roof.position.set(0,1.04,0.13);windshield.position.set(0,1.08,0.11);
        }
        const scale=scaleByCar[p.car_id]||[1,1];
        model.scale.set(scale[0],1,scale[1]);
        model.userData.racerId=id;
        model.userData.carId=String(p.car_id||"2107");
        scene.add(model);
        opponentCars.set(id,model);
      }
    }
    window.addEventListener("allcoins:race-state",event=>setRaceState(event.detail));
    if(window.__allcoinsRaceState)setRaceState(window.__allcoinsRaceState);

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
      roadTexture.offset.y=mod(progress/520,1);
      curbTexture.offset.y=mod(progress/520,1);
      for(const mesh of buildings){mesh.position.z=mod(mesh.userData.baseZ+progress+240,280)-240;}
      for(const mesh of lamps){mesh.position.z=mod(mesh.userData.baseZ+progress+225,276)-225;}
      const players=Array.isArray(raceState.players)?raceState.players:[];
      const me=players.find(p=>p.isMe);
      const myDistance=Number(me?.distance)||0;
      const myIndex=Math.max(0,players.findIndex(p=>p.isMe));
      const laneOf=index=>(index-(Math.max(1,players.length)-1)/2)*2.25;
      car.position.x=players.length>1?laneOf(myIndex):0;
      for(let index=0;index<players.length;index++){
        const player=players[index];
        if(player.isMe)continue;
        const model=opponentCars.get(String(player.id));
        if(!model)continue;
        const delta=Number(player.distance||0)-myDistance;
        model.position.x=laneOf(index);
        model.position.z=2.6-Math.max(-8,Math.min(70,delta))*0.45;
        model.position.y=-0.07;
        model.rotation.y=Math.sin(now*0.0013+index)*0.012*Math.min(1,Number(player.speed||0)/210);
        model.traverse(node=>{
          if(node.userData.rotating)node.children.forEach(child=>{child.rotation.x+=Number(player.speed||0)*dt*0.0017;});
        });
      }
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