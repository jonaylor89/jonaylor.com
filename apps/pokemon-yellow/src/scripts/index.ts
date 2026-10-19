/**
 * Registry of ported scripts. Maps not listed here have no ported script yet;
 * the engine reports them to the debug overlay (see TASKS.md for progress).
 */
import type { MapScript, ScriptRegistry } from './types';
import { PalletTown } from './maps/PalletTown';
import { RedsHouse1F, RedsHouse2F } from './maps/RedsHouse';
import { BluesHouse } from './maps/BluesHouse';
import { OaksLab } from './maps/OaksLab';
import { Route1 } from './maps/Route1';
import { specials } from './specials';
import { Route22 } from './maps/Route22';
import { PewterCity } from './maps/PewterCity';
import { PewterGym } from './maps/PewterGym';
import { Museum1F, PewterPokecenterJigglypuff, MagikarpSalesman } from './maps/PewterMtMoon';
import { MtMoonB2F } from './maps/MtMoonB2F';
import { SummerBeachHouse } from './maps/SummerBeachHouse';
import { Colosseum, TradeCenter } from './maps/LinkRooms';
import { SilphCo1F, SilphCo2F, SilphCo3F, SilphCo4F, SilphCo5F, SilphCo6F, SilphCo7F, SilphCo8F, SilphCo9F, SilphCo10F, SilphCo11F } from './maps/SilphCo';
import { AgathasRoom, BrunosRoom, ChampionsRoom, HallOfFame, IndigoPlateauLobby, LancesRoom, LoreleisRoom } from './maps/EliteFour';
import { CinnabarGym } from './maps/CinnabarGym';
import { mansionSwitches, PokemonMansion1F, PokemonMansion2F, PokemonMansion3F, PokemonMansionB1F } from './maps/PokemonMansion';
import { SafariZoneGate } from './maps/SafariZoneGate';
import { safariGameOverText } from '../engine/safari';
import { PokemonTower2F, PokemonTower5F, PokemonTower6F, PokemonTower7F } from './maps/PokemonTower';
import { RocketHideoutB1F, RocketHideoutB2F, RocketHideoutB3F, RocketHideoutB4F } from './maps/RocketHideout';
import { CeruleanCity } from './maps/CeruleanCity';
import { CeruleanGym, VermilionGym, CeladonGym, FuchsiaGym, SaffronGym, ViridianGym } from './maps/Gyms';
import { ViridianCity } from './maps/ViridianCity';
import { ViridianMart, ViridianPokecenter, ViridianNicknameHouse, ViridianSchoolHouse, Route2 } from './maps/Viridian';
import { commonPatterns, commonTexts } from './common';
import { daycareGentleman } from './maps/Daycare';
import { Route16Gate1F, Route18Gate1F } from './maps/CyclingRoadGates';
import { Route22Gate, Route23 } from './maps/IndigoRoad';
import { BillsHouse, Route24, Route25 } from './maps/CeruleanNorth';
import { VermilionCity } from './maps/Vermilion';
import { VermilionDock } from './maps/VermilionDock';
import { SSAnne2F, SSAnneCaptainsRoom, ssAnne2FRoomsGentleman3 } from './maps/SSAnne';
import { PokemonFanClub } from './maps/FanClub';
import { Route12, Route16 } from './maps/Snorlax';
import { VictoryRoad1F, VictoryRoad2F, VictoryRoad3F } from './maps/VictoryRoad';
import { FightingDojo } from './maps/FightingDojo';
import { GameCorner } from './maps/GameCorner';
import { Route20, SeafoamIslands1F, SeafoamIslandsB1F, SeafoamIslandsB2F, SeafoamIslandsB3F, SeafoamIslandsB4F } from './maps/Seafoam';
import { CeladonMartElevator, RocketHideoutElevator, SilphCoElevator } from './elevator';
import { Route5Gate, Route6Gate, Route7Gate, Route8Gate, saffronGateGuardText } from './maps/SaffronGates';
import { nameRater } from './maps/Lavender';
import { CinnabarIsland, cinnabarLabFossilScientist } from './maps/Cinnabar';
import {
  celadonMansion1FGranny,
  celadonMansion3FProgrammer,
  celadonMansion3FGraphicArtist,
  celadonMansion3FGameDesigner,
  celadonMansion3FCompletedDexAsm,
  celadonMartRoofLittleGirl,
  CeladonCity,
  celadonMansion3FWriter,
  celadonMansionRoofHouseEevee,
  route11Gate2FLeftBinoculars,
} from './maps/Celadon';
import { CeruleanBadgeHouse, ceruleanBadgeHouseMan, bikeShopClerk, ceruleanMelanie, ceruleanTrashedHouseFishingGuru } from './maps/Cerulean';
import { hiddenEventTexts } from '../engine/hiddenEvents';

const maps: MapScript[] = [
  PalletTown,
  RedsHouse1F,
  RedsHouse2F,
  BluesHouse,
  OaksLab,
  Route1,
  ViridianCity,
  ViridianMart,
  ViridianPokecenter,
  ViridianNicknameHouse,
  ViridianSchoolHouse,
  Route2,
  Route22,
  PewterCity,
  PewterGym,
  Museum1F,
  MtMoonB2F,
  CeruleanCity,
  CeruleanGym,
  VermilionGym,
  CeladonGym,
  FuchsiaGym,
  SaffronGym,
  CinnabarIsland,
  Route5Gate,
  Route6Gate,
  Route7Gate,
  Route8Gate,
  Route16Gate1F,
  Route18Gate1F,
  Route22Gate,
  Route23,
  Route24,
  Route25,
  BillsHouse,
  VermilionCity,
  VermilionDock,
  SSAnne2F,
  SSAnneCaptainsRoom,
  PokemonFanClub,
  CeladonMartElevator,
  RocketHideoutElevator,
  SilphCoElevator,
  CeladonCity,
  Route12,
  Route16,
  Route20,
  SeafoamIslands1F,
  SeafoamIslandsB1F,
  SeafoamIslandsB2F,
  SeafoamIslandsB3F,
  SeafoamIslandsB4F,
  VictoryRoad1F,
  VictoryRoad2F,
  VictoryRoad3F,
  FightingDojo,
  RocketHideoutB1F,
  RocketHideoutB2F,
  RocketHideoutB3F,
  RocketHideoutB4F,
  PokemonTower2F,
  PokemonTower5F,
  PokemonTower6F,
  PokemonTower7F,
  SafariZoneGate,
  CinnabarGym,
  IndigoPlateauLobby,
  LoreleisRoom,
  BrunosRoom,
  AgathasRoom,
  LancesRoom,
  ChampionsRoom,
  HallOfFame,
  SilphCo1F,
  SilphCo2F,
  SilphCo3F,
  SilphCo4F,
  SilphCo5F,
  SilphCo6F,
  SilphCo7F,
  SilphCo8F,
  SilphCo9F,
  SilphCo10F,
  SilphCo11F,
  TradeCenter,
  SummerBeachHouse,
  CeruleanBadgeHouse,
  Colosseum,
  PokemonMansion1F,
  PokemonMansion2F,
  PokemonMansion3F,
  PokemonMansionB1F,
  ViridianGym,
  GameCorner,
];

export const SCRIPTS: ScriptRegistry = {
  maps: Object.fromEntries(maps.map((m) => [m.map, m])),
  texts: {
    ...commonTexts,
    ...hiddenEventTexts,
    // text_asm in maps whose map script is boilerplate
    PewterPokecenterJigglypuffText: PewterPokecenterJigglypuff,
    SafariGameOverText: safariGameOverText,
    MtMoonPokecenterMagikarpSalesmanText: MagikarpSalesman,
    DaycareGentlemanText: daycareGentleman,
    SaffronGateGuardText: saffronGateGuardText,
    SSAnne2FRoomsGentleman3Text: ssAnne2FRoomsGentleman3,
    CeruleanMelanieHouseMelanieText: ceruleanMelanie,
    CeruleanTrashedHouseFishingGuruText: ceruleanTrashedHouseFishingGuru,
    BikeShopClerkText: bikeShopClerk,
    CeruleanBadgeHouseMiddleAgedManText: ceruleanBadgeHouseMan,
    NameRatersHouseNameRaterText: nameRater,
    CinnabarLabFossilRoomScientist1Text: cinnabarLabFossilScientist,
    CeladonMansion1FGrannyText: celadonMansion1FGranny,
    CeladonMansion3FProgrammerText: celadonMansion3FProgrammer,
    CeladonMansion3FWriterText: celadonMansion3FWriter,
    CeladonMansion3FGraphicArtistText: celadonMansion3FGraphicArtist,
    CeladonMansion3FGameDesignerText: celadonMansion3FGameDesigner,
    'CeladonMansion3FGameDesignerText.CompletedDexText': celadonMansion3FCompletedDexAsm,
    CeladonMartRoofLittleGirlText: celadonMartRoofLittleGirl,
    CeladonMansionRoofHouseEeveePokeballText: celadonMansionRoofHouseEevee,
    Route11Gate2FLeftBinocularsText: route11Gate2FLeftBinoculars,
  },
  patterns: commonPatterns,
  specials,
  hidden: {
    Mansion1Script_Switches: mansionSwitches('TEXT_POKEMONMANSION1F_SWITCH'),
    Mansion2Script_Switches: mansionSwitches('TEXT_POKEMONMANSION2F_SWITCH'),
    Mansion3Script_Switches: mansionSwitches('TEXT_POKEMONMANSION3F_SWITCH'),
    Mansion4Script_Switches: mansionSwitches('TEXT_POKEMONMANSIONB1F_SWITCH'),
  },
};
