/** Ports of the smaller Viridian maps: ViridianMart, ViridianPokecenter, houses, Route 2. */
import type { MapScript, ScriptFn } from '../types';
import { PAD_LEFT, PAD_UP } from '../../engine/pad';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_VIRIDIANMART_${n}`);

const martScripts: ScriptFn[] = [
  // ViridianMartDefaultScript
  function* (e) {
    e.updateSprites();
    yield* e.displayTextID('TEXT_VIRIDIANMART_CLERK_YOU_CAME_FROM_PALLET_TOWN');
    e.simulateRLE([PAD_LEFT, 1, PAD_UP, 2]);
    e.startSimulatingJoypadStates();
    e.curScript = S('OAKS_PARCEL');
  },
  // ViridianMartOaksParcelScript
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delay3();
    yield* e.displayTextID('TEXT_VIRIDIANMART_CLERK_PARCEL_QUEST');
    e.giveItem('OAKS_PARCEL', 1);
    e.setEvent('EVENT_GOT_OAKS_PARCEL');
    e.curScript = S('SCRIPT2');
  },
  // ViridianMartScript2
  function* (e) {
    if (!e.checkEvent('EVENT_COMPLETED_CATCH_TRAINING')) return;
    if (e.checkAndSetEvent('EVENT_SPAWNED_OLD_MAN_1')) return;
    e.hideObject('TOGGLE_OLD_MAN_2');
    e.showObject('TOGGLE_OLD_MAN_1');
  },
];

export const ViridianMart: MapScript = {
  map: 'VIRIDIAN_MART',
  *run(e) {
    // ViridianMartCheckParcelDeliveredScript: the clerk becomes a mart once Oak has the parcel.
    e.setTextPointers(e.checkEvent('EVENT_OAK_GOT_PARCEL') ? 'ViridianMart_TextPointers2' : undefined);
    e.enableAutoTextBoxDrawing();
    yield* martScripts[e.curScript](e);
  },
};

const autoTextBox = (map: string, texts: MapScript['texts'] = {}): MapScript => ({
  map,
  *run(e) {
    e.enableAutoTextBoxDrawing();
  },
  texts,
});

export const ViridianPokecenter = autoTextBox('VIRIDIAN_POKECENTER');
export const ViridianNicknameHouse = autoTextBox('VIRIDIAN_NICKNAME_HOUSE', {
  *ViridianNicknameHouseSpearowText(e) {
    yield* e.printText('ViridianNicknameHouseSpearowText.Text');
    yield* e.playCry('SPEAROW');
  },
});
export const ViridianSchoolHouse = autoTextBox('VIRIDIAN_SCHOOL_HOUSE');
export const Route2 = autoTextBox('ROUTE_2');
