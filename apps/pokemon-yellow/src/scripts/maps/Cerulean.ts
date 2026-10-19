/**
 * Cerulean City houses: Melanie's Bulbasaur (scripts/CeruleanMelaniesHouse.asm),
 * the trashed house (scripts/CeruleanTrashedHouse.asm) and the Bike Shop clerk
 * (scripts/BikeShop.asm).
 */
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { MapScript } from '../types';
import { PAD_A, PAD_B } from '../../engine/pad';
import { handleMenuInput } from '../../ui/menus';
import { placeString } from '../../ui/mart';
import { displayListMenu } from '../../ui/listMenu';
import { c } from '../../rom/constants';

export function* ceruleanMelanie(e: ScriptEnv) {
  e.doNotWaitForButtonPress = true;
  if (e.checkEvent('EVENT_GOT_BULBASAUR_IN_CERULEAN')) return yield* e.printText('CeruleanHouse1Text_1cfd9');
  yield* e.printText('CeruleanHouse1Text_1cfc8');
  if (e.e.state.pikachu.happiness < 147) return;
  yield* e.printText('CeruleanHouse1Text_1cfce');
  if (!(yield* e.yesNoChoice())) return yield* e.printText('CeruleanHouse1Text_1cfdf');
  e.doNotWaitForButtonPress = true;
  const partyBefore = e.e.state.party.length;
  if (!(yield* e.givePokemon('BULBASAUR', 10))) return;
  if (e.e.state.party.length === partyBefore) yield* e.e.waitForTextScrollButtonPress(); // wAddedToParty == 0
  e.doNotWaitForButtonPress = true;
  yield* e.printText('CeruleanHouse1Text_1cfd3');
  e.hideObject('TOGGLE_CERULEAN_BULBASAUR');
  e.setEvent('EVENT_GOT_BULBASAUR_IN_CERULEAN');
}

export function* ceruleanTrashedHouseFishingGuru(e: ScriptEnv) {
  const T = (n: string) => `CeruleanTrashedHouseFishingGuruText.${n}`;
  yield* e.printText(T(e.isItemInBag('TM_DIG') ? 'WhatsLostIsLostText' : 'TheyStoleATMText'));
}

export function* bikeShopClerk(env: ScriptEnv) {
  const e = env.e;
  if (env.checkEvent('EVENT_GOT_BICYCLE')) return yield* env.printText('BikeShopClerkHowDoYouLikeYourBicycleText');
  if (env.isItemInBag('BIKE_VOUCHER')) {
    yield* env.printText('BikeShopClerkOhThatsAVoucherText');
    if (!env.giveItem('BICYCLE')) return yield* env.printText('BikeShopBagFullText');
    env.removeItem('BIKE_VOUCHER');
    env.setEvent('EVENT_GOT_BICYCLE');
    return yield* env.printText('BikeShopExchangedVoucherText');
  }
  yield* env.printText('BikeShopClerkWelcomeText');
  // the BICYCLE/CANCEL menu is drawn with text delay off, then the question prints over it
  e.ram.noTextDelay = true;
  e.screen.box(0, 0, 4, 15);
  env.updateSprites();
  placeString(e, 2, 2, e.bundle.strings.BikeShopMenuText);
  placeString(e, 8, 3, e.bundle.strings.BikeShopMenuPrice);
  yield* env.printText('BikeShopClerkDoYouLikeItText');
  e.ram.noTextDelay = false;
  const [item, key] = yield* handleMenuInput(e, { topX: 1, topY: 2, maxItem: 1, current: 0, watchedKeys: PAD_A | PAD_B });
  if (!(key & PAD_B) && item === 0) yield* env.printText('BikeShopCantAffordText');
  yield* env.printText('BikeShopComeAgainText');
}

/** CeruleanBadgeHouseMiddleAgedManText: pick a badge from the list to hear what it does. */
export function* ceruleanBadgeHouseMan(env: ScriptEnv) {
  const T = (n: string) => `CeruleanBadgeHouseMiddleAgedManText.${n}`;
  const badges = ['BOULDERBADGE', 'CASCADEBADGE', 'THUNDERBADGE', 'RAINBOWBADGE', 'SOULBADGE', 'MARSHBADGE', 'VOLCANOBADGE', 'EARTHBADGE'];
  const label = ['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth'];
  yield* env.printText(T('Text'));
  const cursor = { item: 0, scroll: 0 };
  for (;;) {
    yield* env.printText(T('WhichBadgeText'));
    const choice = yield* displayListMenu(env.e, { kind: 'special', entries: badges.map((b) => ({ id: c('item', b) })), cursor });
    if (!choice) break;
    yield* env.printText(`CeruleanBadgeHouse${label[choice.index]}BadgeText`);
  }
  yield* env.printText(T('VisitAnyTimeText'));
}

/** CeruleanBadgeHouse_Script: no automatic text box (the badge list draws its own). */
export const CeruleanBadgeHouse: MapScript = {
  map: 'CERULEAN_BADGE_HOUSE',
  *run(e) {
    e.disableAutoTextBoxDrawing();
  },
};
