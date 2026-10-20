import { expect, test } from "@playwright/test";
import { atlasFixture } from "./atlas-fixture";

test("comparison keeps both outer rails, one centered inset, and truthful zero/equal states", async ({page}) => {
  await page.emulateMedia({reducedMotion:"reduce"});
  await atlasFixture(page,"real","complete");
  await page.goto("/");
  await expect.poll(()=>page.evaluate(()=>(window as any).__atlas?.bodies.length ?? 0)).toBeGreaterThan(0);
  // Diagnostic geometry exercises the production shaders; real-data captures stay separate.
  const samples=await page.evaluate(()=>{
    const sc=(window as any).__atlas;
    for(const child of sc.scene.children) child.visible=child.geometry===sc.domeGeo;
    sc.camera.left=-300;sc.camera.right=300;sc.camera.top=300;sc.camera.bottom=-300;
    sc.camera.updateProjectionMatrix();
    sc.domeMat.uniforms.uR.value=60;
    sc.domeMat.uniforms.uPx.value=600/sc.renderer.domElement.clientHeight;
    const g=sc.domeGeo;g.instanceCount=1;
    g.getAttribute("iPos").setXYZ(0,0,0,0);
    g.getAttribute("iR").setX(0,60);g.getAttribute("iLine").setX(0,1.25);
    const output=[];
    for(const turn of [0,Math.PI/2]) {
      sc.camera.position.set(Math.sin(turn)*1000,200,Math.cos(turn)*1000);
      sc.camera.lookAt(0,200,0);sc.camera.updateMatrixWorld();
      for(const [current,start,compare] of [[200,400,1],[400,200,1],[400,0,1],[400,-1,1],[400,400,1],[200,400,0]]) {
        sc.domeMat.uniforms.uCompare.value=compare;
        g.getAttribute("iH").setX(0,current);g.getAttribute("iBase").setX(0,start);
        for(const key of ["iPos","iR","iLine","iH","iBase"])g.getAttribute(key).needsUpdate=true;
        sc.renderer.render(sc.scene,sc.camera);
        const source=sc.renderer.domElement,canvas=document.createElement("canvas");
        canvas.width=source.width;canvas.height=source.height;
        const ctx=canvas.getContext("2d")!;ctx.drawImage(source,0,0);
        const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
        const color=(x:number,y:number)=>{
          const i=(Math.round((.5+(200-y)/600)*canvas.height)*canvas.width+Math.round((.5+x/600)*canvas.width))*4;
          const [r,g,b]=[data[i]!,data[i+1]!,data[i+2]!];
          return r>245&&g>245&&b>245?"white":Math.max(r,g,b)-Math.min(r,g,b)<8?"gray":g-r>20?"mint":"other";
        };
        output.push([color(-43,90),color(0,90),color(43,90),color(0,280)]);
      }
    }
    return output;
  });
  const expected=[
    ["gray","mint","gray","gray"],
    ["mint","gray","mint","mint"],
    ["mint","mint","mint","mint"],
    ["mint","mint","mint","mint"],
    ["mint","mint","mint","mint"],
    ["mint","mint","mint","white"],
  ];
  expect(samples).toEqual([...expected,...expected]);
});
