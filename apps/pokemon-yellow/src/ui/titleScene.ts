/** A presentation-only Pallet Town. Never loads or advances the player's engine. */
import type { GameBundle } from '../data/schema';
import type { OverworldView } from '../render/OverworldView';
import { WorldMap } from '../world/WorldMap';
import { c } from '../rom/constants';

export function mountTitleScene(view: OverworldView, bundle: GameBundle) {
  view.loadMap(new WorldMap(bundle, c('map', 'PALLET_TOWN')), c('palette', 'PAL_PALLET'));
  const actor = (key: string, sprite: string, x: number, y: number) => view.syncActor({ key, sprite: c('sprite', sprite), x, y, facing: 'down', animFrame: 0, lift: 0, visible: true });
  actor('title-trainer', 'SPRITE_RED', 5, 6);
  actor('title-pikachu', 'SPRITE_PIKACHU', 6, 6);
  // Offset the town to the right of the menu; portrait keeps the house above it.
  const follow = () => {
    const portrait = view.canvas.clientWidth <= 650 && view.canvas.clientHeight > 650;
    view.follow(portrait ? 5.5 : 4, portrait ? 10 : 8, 1);
  };
  follow();
  return {
    frame: follow,
    dispose() { view.pruneActors(new Set()); },
  };
}
