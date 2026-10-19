/** Input-only campaign navigation. Reads collision/menus to plan; never writes
 * positions, inventory, progression flags, battle cursors or puzzle solutions.
 * The separate campaign test declares its one combat fixture explicitly.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Harness } from './harness';
import { WorldMap } from '../src/world/WorldMap';
import { DIR_VEC, afterStep, planStep, tilePairBlocked, type Facing } from '../src/world/movement';
import { c, constName } from '../src/rom/constants';
import type { GameBundle } from '../src/data/schema';
import type { GameState } from '../src/game/state';
import { GbBattleHost } from '../src/battle/host';
import type { Button } from '../src/input/Input';

const dirs = Object.keys(DIR_VEC) as Facing[];
const code = (map: number, x: number, y: number, on: boolean) => map * 131072 + Number(on) * 65536 + y * 256 + x;
const unpack = (k: number) => ({ map: Math.floor(k / 131072), x: k % 256, y: Math.floor(k / 256) % 256, on: !!(Math.floor(k / 65536) % 2) });
const GATES: Record<string, number[][]> = {
  POKEMON_MANSION_1F: [[12,6,0x0e,0x2d],[8,3,0x2d,0x0e],[10,8,0x2d,0x0e],[13,13,0x2d,0x0e]],
  POKEMON_MANSION_2F: [[4,2,0x0e,0x5f],[9,4,0x54,0x0e],[3,11,0x5f,0x0e]],
  POKEMON_MANSION_3F: [[7,2,0x0e,0x5f],[7,5,0x5f,0x0e]],
  POKEMON_MANSION_B1F: [[13,8,0x0e,0x2d],[6,11,0x0e,0x5f],[4,3,0x5f,0x0e],[8,8,0x54,0x0e]],
};
type Edge = { from: number; key: number; dir?: Facing; switch?: true };

export class RouteDriver extends Harness {
  acceptMenus = false;
  allowWater = false;
  milestones: { label: string; map: string; frames: number }[] = [];
  readonly inputs: { held: string; frames: number }[] = [];
  readonly fixtures: {frame:number;party:GameState['party'];bag:GameState['bag']}[] = [];
  readonly initialState: GameState;
  readonly flagTrace: {frame:number;map:string;flag:number;label:string;value:boolean}[] = [];
  constructor(bundle: GameBundle,state?: GameState) {
    const initial=state ? structuredClone(state) : undefined;
    super(bundle,state);
    this.initialState=initial ?? structuredClone(this.store.state);
    this.store.subscribe((_state,action) => {
      if (action.type === 'setEvent') this.flagTrace.push({frame:this.frames,map:this.mapName,flag:action.flag,label:constName('event',action.flag) ?? String(action.flag),value:action.value});
    });
  }
  private predictions = new Map<number, WorldMap>();
  private blocked = new Set<string>();
  private failures = new Map<string,number>();
  override step(held: Button[] = []) {
    const key = held.join(','), last = this.inputs.at(-1);
    if (last?.held === key) last.frames++; else this.inputs.push({ held: key, frames: 1 });
    super.step(held);
  }
  has(name: string) { return this.store.state.bag.some((s) => s.item === c('item', name)); }
  mark(label: string) {
    this.blocked.clear(); this.failures.clear(); this.predictions.clear();
    this.milestones.push({ label, map: this.mapName, frames: this.frames });
    console.log(`${label}: ${this.mapName} (${this.p.x},${this.p.y}), ${this.frames} frames`);
    mkdirSync('extracted',{recursive:true});
    writeFileSync('extracted/campaign-latest.json',JSON.stringify({initialState:this.initialState,fixtures:this.fixtures,state:this.store.state,milestones:this.milestones,flagTrace:this.flagTrace,inputs:this.inputs}));
  }
  diagnostic(msg: string): never {
    mkdirSync('extracted',{recursive:true});
    writeFileSync('extracted/campaign-failure.json',JSON.stringify({message:msg,state:this.store.state,blocked:[...this.blocked],milestones:this.milestones,inputs:this.inputs}));
    throw new Error(`${msg}: ${this.mapName} (${this.p.x},${this.p.y}) facing ${this.p.facing} script=${this.engine.curScript} ignore=${this.engine.ram.joyIgnore}\n${this.screenText()}`);
  }
  /** Select visible menu labels, scrolling lists using real D-pad presses. */
  choose(label: string, horizontal = false, max = 150) {
    for (let i = 0; i < max; i++) {
      this.run(5);
      const rows = this.screenText().split('\n');
      const cursor = this.engine.ram.menuCursorLoc;
      if (!cursor || this.engine.screen.get(...cursor) !== 0xed) { this.run(5); continue; }
      const [cx, cy] = cursor;
      const moveMenu = this.inBattle && cx === 5 && cy >= 13 && rows.some((r) => r.includes('TYPE/'));
      const y = rows.findIndex((r,row) => (!moveMenu || row >= 13) && r.includes(label));
      if (y < 0) { this.press(i < 25 ? 'up' : 'down', 4, 6); continue; }
      const targetY = y + Number(cx === 0 && this.store.state.party.some((m) => m.nickname === label));
      const x = rows[y].indexOf(label) - 1;
      if (horizontal && cx !== x) this.press(cx < x ? 'right' : 'left', 4, 6);
      else if (cy !== targetY) this.press(cy < targetY ? 'down' : 'up', 4, 6);
      else { this.press('a', 4, 6); return; }
    }
    this.diagnostic(`Menu label ${label} not reached`);
  }
  settle(max = 900) {
    for (let i = 0; i < max; i++) {
      this.run(5);
      if (this.inBattle) { this.finishBattle(100000); continue; }
      if (!this.textBoxOpen() && !this.engine.ram.fontLoaded && !this.engine.ram.joyIgnore && !this.engine.ram.trainerBattle && !this.engine.ram.seenByTrainer && !this.engine.isPlayerCharacterBeingControlledByGame()) {
        this.run(20);
        if (!this.inBattle && !this.textBoxOpen() && !this.engine.ram.fontLoaded && !this.engine.ram.joyIgnore && !this.engine.ram.trainerBattle && !this.engine.ram.seenByTrainer && !this.engine.isPlayerCharacterBeingControlledByGame()) return;
        continue;
      }
      const menu = this.screenText().includes('YES') && this.screenText().includes('NO');
      this.press(menu && !this.acceptMenus ? 'b' : 'a', 4, 6);
    }
    this.diagnostic('Dialogue did not settle');
  }
  until(pred: () => boolean, max = 1500) {
    for (let i = 0; i < max && !pred(); i++) {
      if (this.inBattle) this.finishBattle(100000);
      const menu = this.screenText().includes('YES') && this.screenText().includes('NO');
      this.press(menu && !this.acceptMenus ? 'b' : 'a', 4, 6);
    }
    if (!pred()) this.diagnostic('Story predicate not reached');
  }
  override finishBattle(max = 100000): number {
    const start = this.frames;
    while (this.inBattle && this.frames - start < max) {
      const battle = (this.engine.battleHost as GbBattleHost).current;
      const text = this.screenText(), cursor = this.engine.ram.menuCursorLoc;
      const liveCursor = cursor && this.engine.screen.get(...cursor) === 0xed;
      if (battle && liveCursor && text.includes('FIGHT') && text.includes('RUN')) {
        const mon = battle.player.mon;
        const elixir = this.has('MAX_ELIXER') && mon.moves[0] && (mon.pp[0] & 63) < 2;
        const heal = this.has('FULL_RESTORE') && (mon.hp < mon.maxHp / 2 || mon.status !== 0);
        if (elixir || heal) {
          this.choose('ITEM', true);
          this.choose(elixir ? 'MAX ELIXER' : 'FULL RESTORE');
          this.choose(mon.nick);
        } else this.choose('FIGHT', true);
      } else if (battle && liveCursor && cursor[0] === 5 && cursor[1] >= 13 && text.includes('TYPE/')) {
        const mon = battle.player.mon;
        let best = -1, power = -1;
        mon.moves.forEach((id, i) => {
          const p = id ? this.bundle.moves[id - 1].power : -1;
          if (id && (mon.pp[i] & 63) && p > power && ((battle.player.disabledMove >> 4) & 15) !== i + 1) { best = i; power = p; }
        });
        if (best >= 0) this.choose(this.bundle.moves[mon.moves[best] - 1].name);
        else this.press('a', 4, 6);
      } else {
        const yesno = text.includes('YES') && text.includes('NO');
        this.press(yesno ? 'b' : 'a', 4, 6);
      }
    }
    if (this.inBattle) this.diagnostic('Battle timed out');
    this.run(30);
    return this.frames - start;
  }
  field(name: 'CUT' | 'SURF' | 'STRENGTH') {
    if (process.env.PYW_ROUTE_LOG) console.log('FIELD',name,'at',this.p,'front',this.engine.world.collisionTile(...this.engine.frontOfPlayer()));
    this.settle();
    this.press('start', 4, 8); this.choose('POKéMON');
    const mon = this.store.state.party.find((m) => m.moves.includes(c('move', name)));
    if (!mon) this.diagnostic(`No field user for ${name}`);
    this.choose(mon.nickname);
    this.choose(name);
    this.settle();
  }
  bag(name: string) {
    this.settle(); this.press('start', 4, 8); this.choose('ITEM');
    this.choose(this.bundle.items.find((i) => i.id === c('item', name))!.name);
    this.choose('USE'); this.settle();
  }
  toss(name: string) {
    this.settle();const before=this.store.state.bag.length;
    this.press('start',4,8);this.choose('ITEM');
    this.choose(this.bundle.items.find((i)=>i.id===c('item',name))!.name);this.choose('TOSS');
    const accept=this.acceptMenus;this.acceptMenus=true;
    this.until(()=>this.store.state.bag.length<before);this.acceptMenus=accept;
    for(let i=0;i<40 && this.engine.ram.fontLoaded;i++)this.press('b',4,8);
    this.settle();
  }
  face(dir: Facing) { if (this.p.facing !== dir) { this.run(12,[dir]); this.run(3); } }
  inspect(x: number, y: number) {
    this.go(this.mapName, dirs.map((d) => { const [dx, dy] = DIR_VEC[d]; return [x-dx, y-dy] as [number, number]; }));
    const dir = dirs.find((d) => { const [dx, dy] = DIR_VEC[d]; return this.p.x+dx === x && this.p.y+dy === y; })!;
    this.face(dir); this.press('a', 4, 6); this.settle();
  }
  talk(index: number) {
    this.settle(); const s = this.engine.sprites[index];
    if (!s || s.hidden) this.diagnostic(`Missing object ${index}`);
    this.inspect(s.mapX, s.mapY);
  }
  /** Solve one real Strength switch/drop using push-state BFS; execute only its
   * next push, then re-plan so trainer interruptions cannot stale the solution. */
  pushBoulder(tx: number,ty: number,event: string) {
    this.field('STRENGTH');
    for (let attempt=0;attempt<160 && !this.store.event(event);attempt++) {
      this.settle();
      const w=this.engine.world, width=w.widthSquares;
      const pos=(x:number,y:number)=>y*width+x;
      const rocks=this.engine.sprites.filter((s)=>s && !s.hidden && s.pictureId && s.slot!==0 && s.movementByte2===c('map_object','BOULDER_MOVEMENT_BYTE_2'));
      type Push={dir:Facing;walk:Facing[];steps:number;slot:number};
      let best:Push|undefined;
      for(const rock of rocks) {
        const fixed=new Set(this.engine.sprites.filter((s)=>s && s.slot!==0 && s.slot!==this.engine.pikachuSlot && s.slot!==rock.slot && !s.hidden && s.pictureId).map((s)=>pos(s.mapX,s.mapY)));
        const floor=(x:number,y:number)=>w.inBounds(x,y) && w.isSquarePassable(x,y) && !fixed.has(pos(x,y));
        type Node={bx:number;by:number;px:number;py:number;first?:{dir:Facing;walk:Facing[]};steps:number};
        const queue:Node[]=[{bx:rock.mapX,by:rock.mapY,px:this.p.x,py:this.p.y,steps:0}];
        const seen=new Set<string>();
        for(let head=0;head<queue.length && head<10000;head++) {
          const n=queue[head], key=`${n.bx},${n.by}:${n.px},${n.py}`;
          if(seen.has(key))continue; seen.add(key);
          if(n.bx===tx && n.by===ty && n.first) {
            if(!best || n.steps<best.steps) best={...n.first,steps:n.steps,slot:rock.slot};
            break;
          }
          if(best && n.steps>=best.steps)continue;
          const root=pos(n.px,n.py), reached=new Map<number,{from:number;dir:Facing}|null>([[root,null]]), cells=[root];
          for(let i=0;i<cells.length;i++) {
            const x=cells[i]%width,y=Math.floor(cells[i]/width);
            for(const dir of dirs) {
              const [dx,dy]=DIR_VEC[dir],nx=x+dx,ny=y+dy,k=pos(nx,ny);
              const hole=w.data.constName==='VICTORY_ROAD_3F' && nx===23 && ny===15;
              if(reached.has(k) || (nx===n.bx && ny===n.by) || !floor(nx,ny) || planStep(w,{x,y,facing:dir,mode:'walk'},dir,{scripted:false,isOccupied:()=>false}).type!=='walk' || afterStep(w,{x:nx,y:ny,facing:dir,mode:'walk'},true).type==='warp' || hole)continue;
              reached.set(k,{from:cells[i],dir});cells.push(k);
            }
          }
          for(const dir of dirs) {
            const [dx,dy]=DIR_VEC[dir],ax=n.bx-dx,ay=n.by-dy,bx=n.bx+dx,by=n.by+dy;
            if(!reached.has(pos(ax,ay)) || !floor(bx,by) || w.collisionTile(bx,by)===0x15 || tilePairBlocked(w,w.collisionTile(n.bx,n.by),w.collisionTile(bx,by)))continue;
            const walk:Facing[]=[];let k=pos(ax,ay);
            while(reached.get(k)){const p=reached.get(k)!;walk.push(p.dir);k=p.from;}
            queue.push({bx,by,px:n.bx,py:n.by,steps:n.steps+1,first:n.first ?? {dir,walk:walk.reverse()}});
          }
        }
      }
      if(!best)this.diagnostic(`No Strength solution for ${event} (${tx},${ty})`);
      if(process.env.PYW_ROUTE_LOG && attempt<4)console.log('PUSH NEXT',attempt,best.slot,best.dir,best.walk,this.p.x,this.p.y);
      let interrupted=false;
      for(const dir of best.walk) {
        const [dx,dy]=DIR_VEC[dir],x=this.p.x+dx,y=this.p.y+dy;
        this.walk(dir);this.settle();
        if(this.p.x!==x || this.p.y!==y){interrupted=true;break;}
      }
      if(interrupted)continue;
      this.walk(best.dir,160);this.settle();
    }
    if(!this.store.event(event))this.diagnostic(`Strength push budget for ${event}`);
  }
  private world(map: number, on: boolean) {
    if (map === this.p.map && on === this.store.event('EVENT_MANSION_SWITCH_ON')) return this.engine.world;
    const key = map * 2 + Number(on);
    let w = this.predictions.get(key);
    if (!w) {
      w = new WorldMap(this.bundle, map); this.predictions.set(key, w);
      for (const [x,y,off,enabled] of GATES[w.data.constName] ?? []) w.replaceBlock(x,y,on ? enabled : off);
      if (this.has('HM_STRENGTH')) {
        // Future switch solutions are planned optimistically, then solved by input on entry.
        if (w.data.constName === 'VICTORY_ROAD_1F') w.replaceBlock(4,6,0x1d);
        if (w.data.constName === 'VICTORY_ROAD_2F') { w.replaceBlock(3,4,0x15); w.replaceBlock(11,7,0x1d); }
        if (w.data.constName === 'VICTORY_ROAD_3F') w.replaceBlock(3,5,0x1d);
      }
    }
    return w;
  }
  private passable(w: WorldMap, x: number, y: number, ignoreNpc: boolean): boolean {
    if (!w.inBounds(x,y)) {
      const cn=w.connectionFor(Math.floor(x/2),Math.floor(y/2));
      return !!cn && this.passable(this.world(cn.map.id,this.store.event('EVENT_MANSION_SWITCH_ON')),cn.bx*2+((x%2)+2)%2,cn.by*2+((y%2)+2)%2,ignoreNpc);
    }
    if (w.data.id === this.p.map && !ignoreNpc && this.engine.sprites.some((s) => s && s.slot !== 0 && s.slot !== this.engine.pikachuSlot && s.pictureId && !s.hidden && s.mapX === x && s.mapY === y)) return false;
    if (w.isSquarePassable(x,y)) return true;
    const tile = w.collisionTile(x,y), ts = w.data.tileset;
    const cuttable = this.bundle.tileTables.cutTreeBlocks.some((s) => s.from === w.blockAt(x >> 1,y >> 1));
    if (cuttable && ts === c('tileset','OVERWORLD') && tile === 0x3d && this.has('HM_CUT') && (this.store.state.badges & 2)) return true;
    if (cuttable && ts === c('tileset','GYM') && tile === 0x50 && this.has('HM_CUT') && (this.store.state.badges & 2)) return true;
    if (this.allowWater && this.bundle.tileTables.waterTilesets.includes(ts) && tile === 0x14 && this.has('HM_SURF') && (this.store.state.badges & 16)) return true;
    if (w.data.constName.startsWith('SILPH_CO_') && this.has('CARD_KEY') && [0x18,0x24,0x5e].includes(tile)) return true;
    return false;
  }
  private lastMap(map: number, warpY: number) {
    const name = this.bundle.maps[map].constName;
    if (name === 'ROUTE_22_GATE') return c('map', warpY < 4 ? 'ROUTE_23' : 'ROUTE_22');
    if (map === this.p.map) return this.p.lastMap;
    const ops = this.bundle.maps[map].scriptOps ?? [];
    const last = ops.find((o) => o.op === 'lastMap');
    if (last?.op === 'lastMap') return last.map;
    return Object.values(this.bundle.maps).find((m) => m.id < c('map', 'FIRST_INDOOR_MAP') && m.warps.some((w) => w.destMap === map))?.id;
  }
  private path(map: number, goals?: [number,number][], ignoreNpc = false): Edge[] | undefined {
    const on = this.store.event('EVENT_MANSION_SWITCH_ON'), start = code(this.p.map,this.p.x,this.p.y,on);
    const queue = [start], prev = new Map<number, Edge | null>([[start,null]]);
    const add = (from: number, key: number, dir?: Facing, toggle?: true) => {
      if (!prev.has(key) && !this.blocked.has(`${from}:${dir ?? 'switch'}`)) { prev.set(key, {from,key,dir,switch:toggle}); queue.push(key); }
    };
    for (let head = 0; head < queue.length; head++) {
      const key = queue[head], p = unpack(key), w = this.world(p.map,p.on);
      if (p.map === map && (!goals || goals.some(([x,y]) => p.x === x && p.y === y))) {
        const out: Edge[] = []; let k = key;
        while (prev.get(k)) { const e = prev.get(k)!; out.push(e); k = e.from; }
        return out.reverse();
      }
      if ((this.bundle.hidden.events[p.map] ?? []).some((h) => h.fn.startsWith('Mansion') && h.x === p.x && h.y === p.y-1)) add(key,code(p.map,p.x,p.y,!p.on),undefined,true);
      for (const dir of dirs) {
        const [dx,dy] = DIR_VEC[dir]; let nx = p.x+dx, ny = p.y+dy, dest = p.map;
        const mover = { x:p.x, y:p.y, facing:dir, mode:'walk' as const };
        const occupied = (x: number,y: number) => w.data.id === this.p.map && !ignoreNpc && this.engine.sprites.some((s) => !!s && s.slot !== 0 && s.slot !== this.engine.pikachuSlot && !!s.pictureId && !s.hidden && s.mapX === x && s.mapY === y);
        let plan = planStep(w,mover,dir,{scripted:false,isOccupied:occupied});
        if (plan.type === 'blocked' && !w.isSquarePassable(nx,ny) && this.passable(w,nx,ny,ignoreNpc)) plan = {type:'walk',x:nx,y:ny};
        if (plan.type === 'blocked') continue;
        let wi = -1;
        if (plan.type === 'warp') wi = plan.warp;
        else {
          nx = plan.x; ny = plan.y;
          const arrival = afterStep(w,{...mover,x:nx,y:ny},true);
          if (arrival.type === 'warp') wi = arrival.warp;
          else if (arrival.type === 'connection') { dest = arrival.map; nx = arrival.x; ny = arrival.y; }
        }
        const arrowName: Record<string,string> = {VIRIDIAN_GYM:'ViridianGym',ROCKET_HIDEOUT_B2F:'RocketHideout2',ROCKET_HIDEOUT_B3F:'RocketHideout3'};
        const arrow = (this.bundle.misc.arrowTiles[arrowName[w.data.constName]] ?? []).find((a) => a.x === nx && a.y === ny);
        if (dest === p.map && arrow) for (let i = 0; i < arrow.rle.length; i += 2) {
          const d: Record<number,Facing> = {16:'right',32:'left',64:'up',128:'down'};
          const [ax,ay] = DIR_VEC[d[arrow.rle[i]]]; nx += ax*arrow.rle[i+1]; ny += ay*arrow.rle[i+1];
        }
        if (wi >= 0) {
          const warp = w.warp(wi); const target = warp.destMap === 255 ? this.lastMap(p.map,warp.y) : warp.destMap;
          const arrival = target === undefined ? undefined : this.bundle.maps[target]?.warps[warp.destWarp];
          if (arrival) { dest = target!; nx = arrival.x; ny = arrival.y; } else continue;
        } else if (w.data.constName === 'POKEMON_MANSION_3F') {
          const hole = [[16,14],[17,14],[19,14]].findIndex(([x,y]) => nx === x && ny === y);
          if (hole >= 0) {
            dest = c('map',hole === 2 ? 'POKEMON_MANSION_2F' : 'POKEMON_MANSION_1F');
            const arrival = this.bundle.specialWarps.dungeon.find((d) => d.map === dest && d.warp === hole+1)!;
            nx = arrival.x; ny = arrival.y;
          }
        }
        if (this.bundle.maps[dest] && this.world(dest,p.on).inBounds(nx,ny)) add(key,code(dest,nx,ny,p.on),dir);
      }
    }
    return undefined;
  }
  go(name: string, goals?: [number,number][] | number, y?: number, options: {stopOnWarp?:boolean} = {}) {
    const target = c('map',name), points = typeof goals === 'number' ? [[goals,y!] as [number,number]] : goals;
    let stalls = 0, lastMap = -1;
    for (let guard = 0; guard < 12000; guard++) {
      this.settle();
      if (process.env.PYW_ROUTE_LOG && (lastMap !== this.p.map || guard % 100 === 0)) console.log('GO',name,goals,'at',this.mapName,this.p.x,this.p.y,'iteration',guard);
      lastMap = this.p.map;
      if (this.p.map === target && (!points || points.some(([x,y]) => this.p.x === x && this.p.y === y))) return;
      const path = this.path(target,points) ?? this.path(target,points,true);
      if (!path?.length) this.diagnostic(`No route to ${name} ${JSON.stringify(points)}`);
      for (const edge of path) {
        const p = unpack(edge.from);
        if (p.map !== this.p.map || p.x !== this.p.x || p.y !== this.p.y) break;
        if (edge.switch) {
          const old = this.acceptMenus; this.acceptMenus = true; this.face('up'); this.press('a',4,6); this.settle(); this.acceptMenus = old; break;
        }
        const dir = edge.dir!, [dx,dy] = DIR_VEC[dir], nx = this.p.x+dx, ny = this.p.y+dy;
        const tile = this.engine.world.collisionTile(nx,ny), ts = this.engine.world.data.tileset;
        if (this.engine.world.inBounds(nx,ny) && !this.engine.world.isSquarePassable(nx,ny)) {
          this.face(dir);
          if ((ts === c('tileset','OVERWORLD') && tile === 0x3d) || (ts === c('tileset','GYM') && tile === 0x50)) this.field('CUT');
          else if (tile === 0x14 && this.store.state.player.mode !== 'surf') this.field('SURF');
          else if (this.engine.world.data.constName.startsWith('SILPH_CO_') && [0x18,0x24,0x5e].includes(tile)) { this.press('a',4,6); this.settle(); }
        }
        const before = `${this.p.map}:${this.p.x},${this.p.y}`;
        this.walk(dir);
        // The final room's cutscene reaches an asynchronous save. Hand the
        // pending warp back to the async driver rather than settling it here.
        if(options.stopOnWarp && unpack(edge.key).map===target && before!==`${this.p.map}:${this.p.x},${this.p.y}`)return;
        if(p.map!==target && this.p.map===target && !points)return;
        this.settle();
        if (before === `${this.p.map}:${this.p.x},${this.p.y}`) {
          this.press('a',4,6); this.settle();
          if (++stalls > 2) { this.blocked.add(`${edge.from}:${dir}`); stalls = 0; }
          break;
        }
        stalls = 0;
        const expected = unpack(edge.key);
        if (expected.map !== this.p.map || expected.x !== this.p.x || expected.y !== this.p.y) {
          if (p.map === this.p.map) {
            const key = `${edge.from}:${dir}`, fails = (this.failures.get(key) ?? 0) + 1;
            this.failures.set(key,fails); if (fails >= 3) this.blocked.add(key);
          }
          break;
        }
        if (this.p.map === target && (!points || points.some(([x,y]) => this.p.x === x && this.p.y === y))) return;
      }
    }
    this.diagnostic(`Navigation step budget to ${name}`);
  }
}
