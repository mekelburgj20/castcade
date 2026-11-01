# Witness-supported games

Which VPX tables the Castcade desktop companion can score for Arcaid Witness on its own. A game is **supported** when the companion reads its machine's live score, game over, current ball and current player from NVRAM (a Stern SAM machine: its scores and the end-of-game record it writes; a Bally AS-2518-17/-35 or Stern M100 machine: its score displays, the GAME OVER lamp and the last game's scores), so every game played on it posts by itself as it ends. **Verified** means supported, and a real game was recorded on that ROM and replays in CI. A supported family without any verified ROM (Bally, Stern M100, Taito, Gottlieb System 3 today) is read from the map alone and has not been played on a rig yet: `docs/design/platform-coverage.md` says what each family rests on and which recording would verify it. **Unsupported** means the companion cannot follow a game on it, and the Reason column says why: no ROM (an original or electro-mechanical table, which needs a table-script recipe), no map for the ROM in pinmame-nvram-maps, or which live fields the map leaves out or keeps in CPU RAM, where the companion cannot see them.

This list is about Witness scoring of VPX tables by the desktop companion, not Castcade matches. Each row is one game of the Virtual Pinball Spreadsheet that has a VPX table; its status is the best of the ROMs VPS lists for it, so a table that runs another ROM revision can differ (a game whose ROMs differ lists each ROM's status in the ROMs column). **Verified** is claimed only for the machine the recording was made on: an original or retheme table that reuses a verified ROM is listed as supported. The JSON next to this page is the same list for ArcAid: https://raw.githubusercontent.com/mekelburgj20/castcade/main/docs/witness-games.json. Regenerate both with `npm run witness-games -w companion` (WORK item B14).

## Versions

- Generated: 2026-11-01T06:03:39.057Z
- VPS database (vps-db commit): `cce9160b30110ee174786239fdfb30a6e4caaab7`
- NVRAM maps (pinmame-nvram-maps commit): `f0c422099f0b50b69bfdf6d071a6653a8b25a6fd`
- Castcade companion: 0.2.27

## Counts

| Platform | Verified | Supported | Unsupported | Games |
|---|---:|---:|---:|---:|
| bally-35-8K | 0 | 77 | 1 | 78 |
| taito | 0 | 66 | 0 | 66 |
| whitestar | 0 | 44 | 0 | 44 |
| williams-system11-48K | 0 | 43 | 0 | 43 |
| stern-sam | 8 | 25 | 0 | 33 |
| dataeast | 1 | 31 | 0 | 32 |
| williams-wpc-12K | 2 | 30 | 0 | 32 |
| gottlieb-system3 | 0 | 25 | 0 | 25 |
| williams-wpc-8K | 0 | 23 | 0 | 23 |
| williams-system9-12K | 0 | 20 | 0 | 20 |
| bally-35-6K | 0 | 19 | 0 | 19 |
| stern-m100 | 0 | 17 | 0 | 17 |
| bally-17-4K | 0 | 10 | 0 | 10 |
| williams-system11-40K | 0 | 4 | 0 | 4 |
| taito-1979 | 0 | 3 | 0 | 3 |
| williams-system9-16K | 0 | 3 | 1 | 4 |
| bally-17-3K | 0 | 2 | 0 | 2 |
| dataeast-v1 | 0 | 2 | 0 | 2 |
| capcom | 0 | 1 | 4 | 5 |
| gottlieb-system3-32K | 0 | 1 | 0 | 1 |
| rowamet | 0 | 1 | 0 | 1 |
| alving | 0 | 0 | 1 | 1 |
| atari-gen1 | 0 | 0 | 4 | 4 |
| atari-gen2 | 0 | 0 | 2 | 2 |
| gottlieb-system1 | 0 | 0 | 18 | 18 |
| gottlieb-system80-1prom | 0 | 0 | 34 | 34 |
| gottlieb-system80-2prom | 0 | 0 | 4 | 4 |
| gottlieb-system80b-10K | 0 | 0 | 15 | 15 |
| gottlieb-system80b-12K | 0 | 0 | 6 | 6 |
| gottlieb-system80b-8K | 0 | 0 | 5 | 5 |
| stern-m200 | 0 | 0 | 45 | 45 |
| williams-system4-2prom | 0 | 0 | 9 | 9 |
| williams-system4-3prom | 0 | 0 | 1 | 1 |
| williams-system6-6K | 0 | 0 | 22 | 22 |
| williams-system7-10K | 0 | 0 | 42 | 42 |
| williams-system7-12K | 0 | 0 | 5 | 5 |
| zaccaria-gen1 | 0 | 0 | 3 | 3 |
| zaccaria-gen2 | 0 | 0 | 8 | 8 |
| no map | 0 | 0 | 1677 | 1677 |
| **All** | **11** | **447** | **1907** | **2365** |

77 games have ROMs that came from pinmame-nvram-maps, not from VPS: VPS lists no ROM for them, and the corpus has a ROM of the same name from the same manufacturer (the Reason column says so). 2 more were left as no ROM because two VPS games share a name and manufacturer and the corpus has no years to tell them apart.

### Why unsupported

| Reason | Games |
|---|---:|
| no ROM (original table: needs recipe B–E, C1.1) | 1460 |
| no map in pinmame-nvram-maps | 217 |
| stern-m200: scores, game_over, current_ball, current_player in CPU RAM | 44 |
| williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM | 42 |
| gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM | 34 |
| williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM | 22 |
| gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM | 18 |
| gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM | 15 |
| williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM | 9 |
| zaccaria-gen2: no game_over, current_ball, current_player in the map | 8 |
| gottlieb-system80b-12K: scores, game_over, current_ball, current_player in CPU RAM | 6 |
| gottlieb-system80b-8K: scores, game_over, current_ball, current_player in CPU RAM | 5 |
| williams-system7-12K: scores, game_over, current_ball, current_player in CPU RAM | 5 |
| atari-gen1: scores, game_over, current_ball, current_player in CPU RAM | 4 |
| capcom: no scores, game_over, current_ball, current_player in the map | 4 |
| gottlieb-system80-2prom: scores, game_over, current_ball, current_player in CPU RAM | 4 |
| zaccaria-gen1: no game_over, current_ball, current_player in the map | 3 |
| atari-gen2: game_over, current_ball, current_player in CPU RAM | 2 |
| alving: no scores, game_over, current_ball, current_player in the map | 1 |
| bally-35-8K: no game_over, current_ball, current_player in the map | 1 |
| stern-m200: no scores, game_over, current_ball, current_player in the map | 1 |
| williams-system4-3prom: scores, game_over, current_ball, current_player in CPU RAM | 1 |
| williams-system9-16K: no game_over, current_ball, current_player in the map | 1 |

## bally-35-8K

0 verified, 77 supported, 1 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| A Real American Hero - Operation P.I.N.B.A.L.L. | Original | 2017 | playboyb | supported |  |
| Alice in Wonderland | Original | 2026 | elektra | supported |  |
| Alice Through the Looking Glass | Original | 2026 | elektra | supported |  |
| Alien 2 | Original | 2023 | startreb | supported |  |
| Black Pyramid | Bally | 1984 | blakpyra | supported |  |
| Bloom - Lunar Howl 5 | Original | 2026 | fathom | supported |  |
| BMX | Bally | 1983 | bmx | supported |  |
| Centaur | Bally | 1981 | centauri unsupported (no map in pinmame-nvram-maps), centaur supported | supported |  |
| Conan | Rowamet | 1983 | rollstob | supported |  |
| Conan the Barbarian | Original | 2026 | rollstob | supported |  |
| Cybernaut | Bally | 1985 | cybrnaut | supported |  |
| Disney Pixar Onward | Original | 2021 | skatebll | supported |  |
| Dolly Parton | Bally | 1979 | dollyptb, dollyptn | supported |  |
| Donald Duck Phantomias | Original | 2022 | blakpyra | supported |  |
| Dr. Jekyll and Mr. Hyde | Original | 2022 | elektra | supported |  |
| Duke Nukem 3D | Original | 2020 | skatebll | supported |  |
| Eight Ball Deluxe | Bally | 1981 | eballdlx | supported |  |
| Elektra | Bally | 1981 | elektra | supported |  |
| Embryon | Bally | 1981 | embryond, embryon | supported |  |
| Fathom | Bally | 1981 | fathom | supported |  |
| Fireball Classic | Bally | 1985 | fbclass | supported |  |
| Fireball II | Bally | 1981 | fball_ii | supported |  |
| Flash Gordon | Bally | 1981 | flashgdn | supported |  |
| Frontier | Bally | 1980 | frontier | supported |  |
| Gold Ball | Bally | 1983 | goldball supported, goldbalc unsupported (no map in pinmame-nvram-maps) | supported |  |
| Grand Slam | Bally | 1983 | gransla4 | supported |  |
| Greedo's Cantina Pinball | Original | 2019 | skatebll | supported |  |
| Halloween 1978-1981 | Original | 2022 | medusa | supported |  |
| Harlem Globetrotters on Tour | Bally | 1979 | hglbtrtb | supported |  |
| Ice Age Christmas | Original | 2021 | skatebll | supported |  |
| Iron Eagle | Original | 2025 | fathom | supported |  |
| Judas Priest | Original | 2019 | skatebll | supported |  |
| Kings of Steel | Bally | 1984 | kosteel | supported |  |
| KISS | Bally | 1979 | kisse, kissc, kiss | supported |  |
| Labyrinth | Original | 2021 | skatebll | supported |  |
| Labyrinth | Original | 2023 | skatebll | supported |  |
| Lilo & Stitch | Original | 2025 | skatebll | supported |  |
| Lunar Howl | Original | 2025 | skatebll | supported |  |
| Magic - The Gathering | Original | 2020 | blakpyra | supported |  |
| Medusa | Bally | 1981 | medusa | supported |  |
| Minecraft | Original | 2020 | skatebll | supported |  |
| Mr. & Mrs. Pac-Man Pinball | Bally | 1982 | m_mpac | supported |  |
| Mystic | Bally | 1980 | mysticb | supported |  |
| New Wave | Bell Games | 1985 | newwave | supported |  |
| Nitro Ground Shaker | Bally | 1980 | ngndshkm unsupported (no map in pinmame-nvram-maps), ngndshkb supported, ngndshkr supported | supported |  |
| Peaky Blinders | Original | 2021 | skatebll | supported |  |
| Playboy | Bally | 1978 | playboyb | supported |  |
| Predator | Original | 2019 | blakpyra | supported |  |
| Predator | Original | 2023 | elektra | supported |  |
| Rolling Stones | Bally | 1980 | rollst21 unsupported (no map in pinmame-nvram-maps), rollstob supported | supported |  |
| Scooby-Doo! and KISS - Rock 'n Roll Mystery | Original | 2015 | kissb | supported |  |
| Silverball Mania | Bally | 1980 | slbmanib, slbmania | supported |  |
| Sin City | Original | 2022 | elektraa, elektra | supported |  |
| Skateball | Bally | 1980 | skatebll | supported |  |
| Speakeasy | Bally | 1982 | speakesy | supported |  |
| Speakeasy 4 | Bally | 1982 | speakes4 | supported |  |
| Spectrum | Bally | 1982 | spectru4 | supported |  |
| SpongeBob | Original | 2020 | fathom | supported |  |
| Spy Hunter | Bally | 1984 | spyhuntr | supported |  |
| Star Trek | Bally | 1979 | startreb | supported |  |
| Star Trek - Spock Tribute | Original | 2022 | skatebll | supported |  |
| Star Trek - The Mirror Universe | Original | 2014 | startreb, startrek | supported |  |
| Stray Cats | Original | 2025 | rollstob | supported |  |
| Super Bowl | Bell Games | 1984 | suprbowl | supported |  |
| Supersonic | Bally | 1979 | sstb, sst | supported |  |
| The Beastmaster | Original | 2021 | blakpyra | supported |  |
| The Delta Force | Original | 2019 | dollyptb | supported |  |
| The Mandalorian | Original | 2020 | cybrnaut | supported |  |
| The Six Million Dollar Man | Bally | 1978 | smmanc, smman | supported |  |
| Tiger King | Original | 2020 | rollstob | supported |  |
| Toxic Tattoo | Original | 2020 | mysticb | supported |  |
| Vector | Bally | 1982 | vector | supported |  |
| Viking | Bally | 1980 | vikingb | supported |  |
| X's & O's | Bally | 1984 | xsandos, xsandosa | supported |  |
| Xenon | Bally | 1980 | xenon | supported |  |
| Young Frankenstein | Original | 2025 | playboyb | supported |  |
| ZZ Top | Original | 2021 | startreb | supported |  |
| Rapid Fire | Bally | 1982 | rapidfir | unsupported | bally-35-8K: no game_over, current_ball, current_player in the map |

## taito

0 verified, 66 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| A-ha | Original | 2025 | vegast | supported |  |
| ABBA | Original | 2020 | vortex | supported |  |
| Ace Ventura - Pet Detective | Original | 2019 | stest | supported |  |
| Airwolf | Original | 2020 | cosmic | supported |  |
| Alfred Hitchcock's Psycho | Original | 2019 | vortex | supported |  |
| Bob Cuspe | Original | 2025 | drakor | supported |  |
| Buzz Off! | Original | 2026 | sureshot | supported |  |
| Cavaleiro Negro | Taito do Brasil | 1980 | cavnegro | supported |  |
| Cosmic | Taito do Brasil | 1980 | cosmic | supported |  |
| Cosmic Battle Girls | Original | 2025 | cosmic | supported |  |
| Cowgirl | Original | 2026 | gemini | supported |  |
| Dick Tracy | Original | 2024 | vortex | supported |  |
| Dire Straits | Original | 2025 | gork | supported |  |
| Dirty Dancing | Original | 2022 | stest | supported |  |
| Drakor | Taito do Brasil | 1979 | drakor | supported |  |
| Father Ted | Original | 2024 | stest | supported |  |
| Fire Action | Taito do Brasil | 1980 | fireact | supported |  |
| Fire Action De Luxe | Taito do Brasil | 1983 | fireactd | supported |  |
| Galaxy Quest | Original | 2020 | sshuttle | supported |  |
| Gemini 2000 | Taito do Brasil | 1982 | gemini | supported |  |
| Gork | Taito do Brasil | 1982 | gork | supported |  |
| Hawkman | Taito do Brasil | 1983 | hawkman | supported |  |
| Hot Racers | Original | 2026 | gork | supported |  |
| Indochine | Original | 2020 | cosmic | supported |  |
| Iron Maiden 2 | Original | 2026 | gemini | supported |  |
| Lady Luck | Taito do Brasil | 1980 | ladylukt | supported |  |
| Lunelle | Taito do Brasil | 1981 | lunelle | supported |  |
| Lupine and Howling - Lunar Howl 3 | Original | 2026 | gemini | supported |  |
| Meteor | Taito do Brasil | 1979 | meteort | supported |  |
| Mickey Mouse Happy Halloween | Original | 2022 | stest | supported |  |
| Monty Python | Original | 2022 | sharkt | supported |  |
| Mr. Black | Taito do Brasil | 1984 | mrblack | supported |  |
| Mystery Science Theater 3000 - Pinball Peril | Original | 2021 | polar | supported |  |
| Namkwah | Original | 2025 | hawkman | supported |  |
| Oba-Oba | Taito do Brasil | 1979 | obaoba | supported |  |
| Once Upon A Time In The West | Original | 2019 | gork | supported |  |
| Pet Shop Boys Show | Original | 2025 | fireactd | supported |  |
| Polar Explorer | Taito do Brasil | 1983 | polar | supported |  |
| Rally | Taito do Brasil | 1980 | rally | supported |  |
| Rat Fink | Original | 2025 | stest | supported |  |
| Resident Evil VII | Original | 2019 | fireactd | supported |  |
| Rio Travel | Original | 2025 | obaoba | supported |  |
| Santana | Original | 2025 | vortex | supported |  |
| Saturday Night Fever | Original | 2025 | cosmic | supported |  |
| Shark | Taito do Brasil | 1982 | sharkt | supported |  |
| Snake Machine | Taito do Brasil | 1982 | snake | supported |  |
| Soul Reaver | Original | 2019 | titan | supported |  |
| Space Shuttle | Taito do Brasil | 1985 | sshuttle | supported |  |
| Speed Test | Taito do Brasil | 1982 | stest | supported |  |
| Stephen King's Sleepwalkers | Original | 2019 | sharkt | supported |  |
| Supertramp Show | Original | 2025 | drakor | supported |  |
| Sure Shot | Taito do Brasil | 1981 | sureshot | supported |  |
| The Flower Man | Original | 2025 | snake | supported |  |
| The Last Starfighter | Original | 2023 | fireactd | supported |  |
| The Rocky Horror Picture Show | Original | 2022 | stest | supported |  |
| The Warriors | Original | 2023 | sharkt | supported |  |
| Titan | Taito do Brasil | 1981 | titan | supported |  |
| Titan Music | Original | 2025 | titan | supported |  |
| Top Gun | Original | 2019 | sshuttle | supported |  |
| Triumph | Original | 2021 | vortex | supported |  |
| Vegas | Taito do Brasil | 1980 | vegast | supported |  |
| Volley | Taito do Brasil | 1981 | voleybal | supported |  |
| Vortex | Taito do Brasil | 1983 | vortex | supported |  |
| Wednesday | Original | 2023 | mrblack | supported |  |
| Wild Ash - Lunar Howl 6 | Original | 2026 | vortex | supported |  |
| Zarza | Taito do Brasil | 1982 | zarza | supported |  |

## whitestar

0 verified, 44 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Apollo 13 | Sega | 1995 | apollo13 | supported |  |
| Austin Powers | Stern | 2001 | austin | supported |  |
| Dale Jr. | Stern | 2007 | dalejr | supported |  |
| Day of the Tentacle | Original | 2023 | playboys | supported |  |
| Death Race 2000 | Original | 2022 | nascar | supported |  |
| Elvis | Stern | 2004 | elvis | supported |  |
| Godzilla | Sega | 1998 | godzilla | supported |  |
| Godzilla Remix (Limited Edition) | Original | 2021 | godzilla | supported |  |
| Goldeneye | Sega | 1996 | gldneye | supported |  |
| Grand Prix | Stern | 2005 | gpr301, gpr301f, gpr301g, gpr301i, gpr301l, gpr340, gpr340f, gpr340g, gpr340i, gpr340l, gpr350, gpr350f, gpr350g, gpr350i, gpr350l, gpr352, gpr352f, gpr352g, gpr352i, gpr352l, gpr400, gpr400f, gpr400g, gpr400i, gpr400l, gprix, gprixf, gprixg, gprixi, gprixl | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Grease | Original | 2020 | elvis | supported |  |
| Harley-Davidson | Sega | 1999 | harl_a30, harl_a13 | supported |  |
| High Roller Casino | Stern | 2001 | hirolcas | supported |  |
| Independence Day | Sega | 1996 | id4 | supported |  |
| James Bond | Original | 2021 | gldneye | supported |  |
| JP's Dale Jr. Nascar | Original | 2020 | dalejr | supported |  |
| JP's Nascar Race | Original | 2015 | dalejr, nascar, gprix | supported |  |
| JP's Terminator 3 | Stern | 2003 | term3 | supported |  |
| JP's The Lord of the Rings | Stern | 2003 | lotr | supported |  |
| JP's The Lost World Jurassic Park | Original | 2020 | jplstw22 | supported |  |
| Kong vs. Godzilla | Original | 2023 | godzilla | supported |  |
| Lost in Space | Sega | 1998 | lostspc | supported |  |
| Mad Max - Fury Road | Original | 2021 | twst_405 | supported |  |
| Monopoly | Stern | 2001 | monopoly | supported |  |
| NASCAR | Stern | 2005 | dalejr, nascar | supported |  |
| NFL | Stern | 2001 | nfl | supported |  |
| Playboy | Stern | 2002 | playboys | supported |  |
| Ripley's Believe it or Not! | Stern | 2004 | ripleys, ripleysl, ripleysi, ripleysg, ripleysf | supported |  |
| RollerCoaster Tycoon | Stern | 2002 | rctycn | supported |  |
| Sharkey's Shootout | Stern | 2000 | shrkysht | supported |  |
| South Park | Sega | 1999 | sprk_103 | supported |  |
| Space Jam | Sega | 1996 | spacejam | supported |  |
| Star Craft Pinball | Original | 2026 | startrp2 | supported |  |
| Star Wars Trilogy Special Edition | Sega | 1997 | swtril43 | supported |  |
| Starship Troopers | Sega | 1997 | startrp, startrp2 | supported |  |
| Striker Xtreme | Stern | 2000 | strikext | supported |  |
| Terminator 3 - Rise of the Machines | Stern | 2003 | term3 | supported |  |
| The Lord of the Rings | Stern | 2003 | lotr | supported |  |
| The Simpsons Pinball Party | Stern | 2003 | simpprty | supported |  |
| The Simpsons Treehouse of Horror | Original | 2020 | simpprty | supported |  |
| The Sopranos | Stern | 2005 | sopranos | supported |  |
| The X Files | Sega | 1997 | xfiles304, xfiles | supported |  |
| Twister | Sega | 1996 | twst_405 | supported |  |
| Viper Night Drivin' | Sega | 1998 | viprsega | supported |  |

## williams-system11-48K

0 verified, 43 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Ace of Speed | Original | 2019 | mousn_l4 | supported |  |
| Bad Cats | Williams | 1989 | bcats_f1 unsupported (no map in pinmame-nvram-maps), bcats_tcm13 unsupported (no map in pinmame-nvram-maps), bcats_tcm12 unsupported (no map in pinmame-nvram-maps), bcats_tcm unsupported (no map in pinmame-nvram-maps), bcats_g4 unsupported (no map in pinmame-nvram-maps), bcats_l5 supported | supported |  |
| Banzai Run | Williams | 1988 | bnzai_l3 | supported |  |
| Big Guns | Williams | 1987 | bguns_l8 | supported |  |
| Black Knight 2000 | Williams | 1989 | bk2k_l4 | supported |  |
| Bugs Bunny's Birthday Ball | Bally | 1990 | bbnny_l2 | supported |  |
| Captain Future | Original | 2022 | rdkng_l4 | supported |  |
| Cyclone | Williams | 1988 | cycln_l5 | supported |  |
| Death Proof | Original | 2021 | mousn_l4 | supported |  |
| Deep Purple - Smoke on the Water | Original | 2024 | fire_l3 | supported |  |
| Diner | Williams | 1990 | diner_l4fr unsupported (no map in pinmame-nvram-maps), diner_l4 supported | supported |  |
| Dr. Dude and His Excellent Ray | Bally | 1990 | dd_l2 | supported |  |
| Earthshaker | Williams | 1989 | esha_la3 | supported |  |
| Elvira and the Party Monsters | Bally | 1989 | eatpm_l4 | supported |  |
| Elvira's House of Horrors Remix | Original | 2021 | eatpm_l4 | supported |  |
| Everquest Pinball Tribute | Original | 2023 | spstn_l5 | supported |  |
| F-14 Tomcat | Williams | 1987 | f14_l1 | supported |  |
| Fallout - Season One | Original | 2024 | swrds_l2 | supported |  |
| Fire! | Williams | 1987 | fire_l3 | supported |  |
| Jokerz! | Williams | 1988 | jokrz_l6 | supported |  |
| JP's Cyclone | Original | 2022 | cycln_l5 | supported |  |
| Mad Max 2 - The Road Warrior | Original | 2019 | rdkng_l4 | supported |  |
| Mega Man | Original | 2023 | radcl_l1 | supported |  |
| Millionaire | Williams | 1987 | milln_l3 | supported |  |
| Mousin' Around! | Bally | 1989 | mousn_l4 | supported |  |
| PIN-BOT | Williams | 1986 | pb_j5 unsupported (no map in pinmame-nvram-maps), pb_l5 supported | supported |  |
| Pink Floyd | Original | 2022 | esha_la3 | supported |  |
| Police Force | Williams | 1989 | polic_lx5pi unsupported (no map in pinmame-nvram-maps), polic_lx5 unsupported (no map in pinmame-nvram-maps), polic_l4 supported | supported |  |
| Pool Sharks | Bally | 1990 | pool_l7 | supported |  |
| Radical! | Bally | 1990 | radcl_l1c unsupported (no map in pinmame-nvram-maps), radcl_l1 supported | supported |  |
| Radical! (prototype) | Bally | 1990 | radcl_l1 supported, radcl_l1c unsupported (no map in pinmame-nvram-maps) | supported |  |
| Riverboat Gambler | Williams | 1990 | rvrbt_l3 | supported |  |
| Road Kings | Williams | 1986 | rdkng_l4 | supported |  |
| Rollergames | Williams | 1990 | rollr_ta2 unsupported (no map in pinmame-nvram-maps), rollr_l2 supported | supported |  |
| Space Oddity | Original | 2022 | spstn_l5 | supported |  |
| Space Station | Williams | 1987 | spstn_l5 | supported |  |
| Swords of Fury | Williams | 1988 | swrds_rr1 unsupported (no map in pinmame-nvram-maps), swrds_rr1b unsupported (no map in pinmame-nvram-maps), swrds_l2 supported | supported |  |
| Taxi | Williams | 1988 | taxi_l4 | supported |  |
| The Bally Game Show | Bally | 1990 | gs_lu4 supported, gs_l4 unsupported (no map in pinmame-nvram-maps) | supported |  |
| Transporter the Rescue | Bally | 1989 | tsptr_lx4 unsupported (no map in pinmame-nvram-maps), tsptr_lx4b unsupported (no map in pinmame-nvram-maps), tsptr_l3fj unsupported (no map in pinmame-nvram-maps), tsptr_l3 supported | supported |  |
| Wayne's World | Original | 2020 | radcl_l1 | supported |  |
| Whirlwind | Williams | 1990 | whirl_l3 | supported |  |
| Who Framed Roger Rabbit | Original | 2021 | bk2k_l4 | supported |  |

## stern-sam

8 verified, 25 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| AC/DC (Let There Be Rock Limited Edition) | Stern | 2012 | acd_170h | verified |  |
| AC/DC (LUCI Premium) | Stern | 2013 | acd_170h | verified |  |
| AC/DC (LUCI Vault Edition) | Stern | 2018 | acd_170h | verified |  |
| AC/DC (Premium) | Stern | 2012 | acd_170h | verified |  |
| AC/DC (Pro Vault Edition) | Stern | 2017 | acd_170h | verified |  |
| AC/DC (Pro) | Stern | 2012 | acd_170h | verified |  |
| AC/DC Back In Black (Limited Edition) | Stern | 2012 | acd_170h | verified |  |
| The Walking Dead (Limited Edition) | Stern | 2014 | twd_160h | verified |  |
| 24 | Stern | 2009 | twenty4_150 | supported |  |
| Batman | Stern | 2008 | bdk_294 | supported |  |
| Big Buck Hunter Pro | Stern | 2010 | bbh_170 | supported |  |
| CSI | Stern | 2008 | csi_240 | supported |  |
| Disney TRON Legacy (Limited Edition) | Stern | 2011 | trn_174h | supported |  |
| Family Guy | Stern | 2007 | fg_1200af | supported |  |
| Iron Man | Stern | 2010 | im_185ve supported, im_183 unsupported (no map in pinmame-nvram-maps) | supported |  |
| Iron Man (Pro Vault Edition) | Stern | 2014 | im_185ve | supported |  |
| James Cameron's Avatar | Stern | 2010 | avr_110 unsupported (no map in pinmame-nvram-maps), avr_200 supported | supported |  |
| JP's Metallica Pro | Stern | 2013 | mtl_180 | supported |  |
| JP's Spider-Man | Original | 2018 | smanve_101 | supported |  |
| JP's Star Trek (Enterprise Limited Edition) | Original | 2020 | st_162h | supported |  |
| JP's The Walking Dead | Original | 2021 | twd_160h | supported | verified on Walking Dead, The Limited Edition; this game is another table on that ROM |
| JP's Transformers | Original | 2018 | tf_180 | supported |  |
| Metallica - Master of Puppets | Original | 2020 | mtl_170h | supported |  |
| Metallica (Premium Monsters) | Stern | 2013 | mtl_170h supported, mtl180le.bin unsupported (no map in pinmame-nvram-maps) | supported |  |
| Metallica Remastered | Original | 2026 | mtl_180 | supported |  |
| NBA | Stern | 2009 | nba_802 | supported |  |
| Spider-Man (Vault Edition) | Stern | 2016 | smanve_101 | supported |  |
| Star Trek (Enterprise Limited Edition) | Stern | 2013 | st_161h, st_162h | supported |  |
| The Avengers (Pro) | Stern | 2012 | avs_170 supported, avs_170h unsupported (no map in pinmame-nvram-maps) | supported |  |
| The Return Of The Living Dead | Original | 2024 | twd_160h | supported | verified on Walking Dead, The Limited Edition; this game is another table on that ROM |
| Transformers (Pro) | Stern | 2011 | tf_180 | supported |  |
| X-Men Magneto LE | Stern | 2012 | xmn_151h | supported |  |
| X-Men Wolverine LE | Stern | 2012 | xmn_151h | supported |  |

## dataeast

1 verified, 31 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Tales from the Crypt | Data East | 1993 | tftc_400 verified, tftc_303 supported | verified |  |
| Aaron Spelling | Data East | 1992 | aar_101 | supported |  |
| Adventures of Rocky and Bullwinkle and Friends | Data East | 1993 | rab_110be unsupported (no map in pinmame-nvram-maps), rab_103it unsupported (no map in pinmame-nvram-maps), rab_320 supported | supported |  |
| Back to the Future | Data East | 1990 | bttf_a28, bttf_a27 | supported |  |
| Batman | Data East | 1991 | btmn_106 | supported |  |
| Batman Forever | Sega | 1995 | batmanf501 supported, bmf_it3 supported, bmf_it2 supported, bmf_nl302 unsupported (no map in pinmame-nvram-maps), batmanf5 supported, batmanf supported | supported |  |
| Baywatch | Sega | 1995 | bay_402 unsupported (no map in pinmame-nvram-maps), baywatch supported | supported |  |
| Boxster Pinball | Original | 2010 | ckpt_a17 | supported |  |
| Checkpoint | Data East | 1991 | ckpt_a17 | supported |  |
| Ghost | Original | 2023 | poto_a32 | supported |  |
| Guns N' Roses | Data East | 1994 | gnr_300 | supported |  |
| Hook | Data East | 1992 | hook_501, hook_500, hook_408 | supported |  |
| Jurassic Park | Data East | 1993 | jupk_600, jupk_513 | supported |  |
| Last Action Hero | Data East | 1993 | lah_113, lah_112 | supported |  |
| Lethal Weapon 3 | Data East | 1992 | lw3_208 | supported |  |
| Mary Shelley's Frankenstein | Sega | 1995 | frankst | supported |  |
| Maverick | Data East | 1994 | mav_404g unsupported (no map in pinmame-nvram-maps), mav_402 supported | supported |  |
| Michael Jordan | Data East | 1992 | mj_130 | supported |  |
| Monday Night Football | Data East | 1989 | mnfb_c27 | supported |  |
| Pantera | Original | 2020 | gnr_300 | supported |  |
| Phantom of the Opera | Data East | 1990 | poto_a32 | supported |  |
| Playboy 35th Anniversary | Data East | 1989 | play_a24 | supported |  |
| Robocop | Data East | 1989 | robo_a34 | supported |  |
| Secret Service | Data East | 1988 | ssvc_a26 | supported |  |
| Star Trek | Data East | 1991 | trek_201 supported, trek_301 unsupported (no map in pinmame-nvram-maps) | supported |  |
| Star Wars | Data East | 1992 | stwr_107, stwr_106, stwr_104, stwr_a14 | supported |  |
| Teenage Mutant Ninja Turtles | Data East | 1991 | tmnt_200.zip unsupported (no map in pinmame-nvram-maps), tmnt_104 supported | supported |  |
| The Simpsons | Data East | 1990 | simp_a27 | supported |  |
| The Who's Tommy Pinball Wizard | Data East | 1994 | tomy_500 | supported |  |
| Time Machine | Data East | 1988 | tmac_a24 | supported |  |
| Torpedo Alley | Data East | 1988 | torp_e21 | supported |  |
| WWF Royal Rumble | Data East | 1994 | wwfr_103, wwfr_106 | supported |  |

## williams-wpc-12K

2 verified, 30 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Medieval Madness | Williams | 1997 | mm_109c verified, mm_109b supported, mm_10 supported | verified |  |
| Monster Bash | Williams | 1998 | mb_106b | verified |  |
| Attack & Revenge from Mars | Original | 2015 | afm_113 | supported |  |
| Attack from Mars | Bally | 1995 | afm_113b | supported |  |
| Cactus Canyon | Bally | 1998 | cc_13 | supported |  |
| Cirqus Voltaire | Bally | 1997 | cv_20h | supported |  |
| Congo | Williams | 1995 | congo_21 | supported |  |
| Corvette | Bally | 1994 | corv_21 | supported |  |
| Demolition Man | Williams | 1994 | dm_lx4 | supported |  |
| Dirty Harry | Williams | 1995 | dh_lx2 | supported |  |
| Indiana Jones - The Pinball Adventure | Williams | 1993 | ij_l7 | supported |  |
| Indianapolis 500 | Bally | 1995 | i500_11r | supported |  |
| Jack-Bot | Williams | 1995 | jb_10r | supported |  |
| Johnny Mnemonic | Williams | 1995 | jm_12r | supported |  |
| Judge Dredd | Bally | 1993 | jd_l1 | supported |  |
| Junk Yard | Williams | 1996 | jy_12 | supported |  |
| Mars Attacks! Pinball | Original | 2022 | afm_113b | supported |  |
| NBA Fastbreak | Bally | 1997 | nbaf_31 | supported |  |
| No Fear - Dangerous Sports | Williams | 1995 | nf_23x | supported |  |
| No Good Gofers | Williams | 1997 | ngg_13 | supported |  |
| Popeye Saves the Earth | Bally | 1994 | pop_lx5 | supported |  |
| Red & Ted's Road Show | Williams | 1994 | rs_l6 | supported |  |
| Safe Cracker | Bally | 1996 | sc_18n11 supported, sc_18s11 supported, sc_091 supported, sc_18 unsupported (no map in pinmame-nvram-maps) | supported |  |
| Scared Stiff | Bally | 1996 | ss_15 | supported |  |
| Star Trek - The Next Generation | Williams | 1993 | sttng_x9 unsupported (no map in pinmame-nvram-maps), sttng_l7 supported, 7 unsupported (no map in pinmame-nvram-maps) | supported |  |
| Tales of the Arabian Nights | Williams | 1996 | totan_14 | supported |  |
| The Champion Pub | Bally | 1998 | cp_16 | supported |  |
| The Flintstones | Williams | 1994 | fs_lx5 | supported |  |
| The Shadow | Bally | 1994 | ts_lx5 | supported |  |
| Theatre of Magic | Bally | 1995 | tom_13 | supported |  |
| WHO dunnit | Bally | 1995 | wd_12 | supported |  |
| World Cup Soccer | Bally | 1994 | wcs_la1, wcs_l2 | supported |  |

## gottlieb-system3

0 verified, 25 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Barb Wire | Gottlieb | 1996 | barbwire | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Cactus Jack's | Gottlieb | 1991 | cactjack | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Car Hop | Gottlieb | 1991 | carhop | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Class of 1812 | Gottlieb | 1991 | clas1812 | supported |  |
| Cue Ball Wizard | Gottlieb | 1992 | cueball, cueball1, cueball2, cueball3 | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Deadly Weapon | Gottlieb | 1990 | deadweap | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Freddy - A Nightmare on Elm Street | Gottlieb | 1994 | freddy, freddy4 | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Gladiators | Gottlieb | 1993 | gladiatr | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Hoops | Gottlieb | 1991 | hoops | supported |  |
| Mario Andretti | Gottlieb | 1995 | andrett4, andretti | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Operation Thunder | Gottlieb | 1992 | opthund | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Rescue 911 | Gottlieb | 1994 | rescu911 | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Shaq Attaq | Gottlieb | 1995 | shaqatt2, shaqattq | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Silver Slugger | Gottlieb | 1990 | silvslug | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Stargate | Gottlieb | 1995 | stargat1, stargat2, stargat3, stargat4, stargat5, stargate | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Street Fighter II | Gottlieb | 1993 | sfight2, sfight2a, sfight2b | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Super Mario Bros. | Gottlieb | 1992 | smb3 | supported |  |
| Super Mario Bros. Mushroom World | Gottlieb | 1992 | smbmush | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Surf 'n Safari | Gottlieb | 1991 | surfnsaf | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Tee'd Off | Gottlieb | 1993 | teedoff3, teedoff | supported |  |
| Title Fight | Gottlieb | 1990 | tfight | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Vegas | Gottlieb | 1990 | vegas | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Waterworld | Gottlieb | 1995 | waterwl2, waterwl5, waterwld | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| Wipe Out | Gottlieb | 1993 | wipeout, wipeouta | supported | ROM from pinmame-nvram-maps (VPS lists none) |
| World Challenge Soccer | Gottlieb | 1994 | wcsoccd2, wcsoccer | supported | ROM from pinmame-nvram-maps (VPS lists none) |

## williams-wpc-8K

0 verified, 23 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Black Rose | Bally | 1992 | br_l4 | supported |  |
| Bram Stoker's Dracula | Williams | 1993 | drac_l1 | supported |  |
| Cheech & Chong - Road-Trip'pin | Original | 2021 | che_cho | supported |  |
| Creature from the Black Lagoon | Bally | 1992 | cftbl_l4 | supported |  |
| Doctor Strange | Original | 2023 | dw_l2 | supported |  |
| Doctor Who | Bally | 1992 | dw_l2, dw_l1, dw_p5 | supported |  |
| Fast and Furious | Original | 2022 | gw_l5 | supported |  |
| Fish Tales | Williams | 1992 | ft_l5p, ft_l5 | supported |  |
| Funhouse | Williams | 1990 | fh_905h supported, fh_l9 supported, fh_905hbs unsupported (no map in pinmame-nvram-maps), fh_907h unsupported (no map in pinmame-nvram-maps) | supported |  |
| Gilligan's Island | Bally | 1991 | gi_l9 | supported |  |
| Harley-Davidson | Bally | 1991 | hd_l3 | supported |  |
| Hurricane | Williams | 1991 | hurr_l2 | supported |  |
| JP's Addams Family | Bally | 1992 | taf_l6 | supported |  |
| JP's Terminator 2 | Original | 2020 | t2_l8 | supported |  |
| Killer Klowns | Original | 2023 | hurr_l2 | supported |  |
| Terminator 2 - Judgment Day | Williams | 1991 | t2_l8 | supported |  |
| The Addams Family | Bally | 1992 | taf_l7, tafg_lx3 | supported |  |
| The Getaway - High Speed II | Williams | 1992 | gw_l5 | supported |  |
| The Machine - Bride of Pin-bot | Williams | 1991 | bop_l8 | supported |  |
| The Party Zone | Bally | 1991 | pz_f4 | supported |  |
| Twilight Zone | Bally | 1993 | tz_94h, tz_94ch | supported |  |
| Vampirella | Original | 2024 | drac_l1 | supported |  |
| White Water | Williams | 1993 | ww_lh6 | supported |  |

## williams-system9-12K

0 verified, 20 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Alien Nostromo | Original | 2022 | sorcr_l2 | supported |  |
| Alien Nostromo 2 | Original | 2024 | sorcr_l1 | supported |  |
| Aliens | Original | 2020 | sorcr_l2 | supported |  |
| Backstreet Boys | Original | 2025 | sorcr_l1 | supported |  |
| Def Leppard | Original | 2025 | sorcr_l1 | supported |  |
| Def Leppard Hits Vegas | Original | 2025 | sorcr_l1 | supported |  |
| Joe Cocker | Original | 2025 | sorcr_l1 | supported |  |
| Lenny Kravitz | Original | 2025 | sorcr_l1 | supported |  |
| Meat Loaf | Original | 2025 | sorcr_l1 | supported |  |
| Ozzy Osbourne | Original | 2025 | sorcr_l1 | supported |  |
| Poison | Original | 2025 | sorcr_l1 | supported |  |
| Rage Against the Machine | Original | 2025 | sorcr_l1 | supported |  |
| Saucerer | Original | 2025 | sorcr_l1 | supported |  |
| Sorcerer | Williams | 1985 | sorcr_l2, sorcr_l1 | supported |  |
| Terminator Genisys | Original | 2019 | sorcr_l1 | supported |  |
| The Shining | Original | 2022 | sorcr_l1 | supported |  |
| TOTO | Original | 2025 | sorcr_l1 | supported |  |
| Trust | Original | 2026 | sorcr_l2, sorcr_l1 | supported |  |
| Van Halen | Original | 2025 | sorcr_l1 | supported |  |
| ZZ Top | Original | 2025 | sorcr_l1 | supported |  |

## bally-35-6K

0 verified, 19 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Christmas Pinball | Original | 2018 | playboy | supported |  |
| Chuck Berry | Original | 2020 | lostwrld | supported |  |
| Dark Rider | Geiger | 1984 | startrek | supported |  |
| Death Wish 3 | Original | 2019 | lostwrld | supported |  |
| Future Spa | Bally | 1979 | futurspa | supported |  |
| Gunship | Original | 2023 | lostwrld | supported |  |
| Heineken | Original | 2020 | ngndshkr | supported |  |
| Hotdoggin' | Bally | 1980 | hotdoggn | supported |  |
| Les Mystérieuses Cités d'or | Original | 2022 | sst | supported |  |
| Lost World | Bally | 1978 | lostwrld | supported |  |
| National Lampoon's Christmas Vacation | Original | 2019 | playboy | supported |  |
| Ouija | Original | 2020 | sst | supported |  |
| Paragon | Bally | 1979 | paragon | supported |  |
| Pink Floyd Pinball | Original | 2020 | playboy | supported |  |
| Red Sonja | Original | 2019 | ngndshkr | supported |  |
| Sandra - The 80's Pop Star | Original | 2025 | futurspa | supported |  |
| Sexy Girl | Arkon | 1980 | playboy | supported |  |
| Space Invaders | Bally | 1980 | spaceinv, spaceinb | supported |  |
| Voltan Escapes Cosmic Doom | Bally | 1979 | voltan | supported |  |

## stern-m100

0 verified, 17 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Cool Spot | Original | 2019 | princess | supported |  |
| Cosmic Princess | Stern | 1979 | princess | supported |  |
| Dracula | Stern | 1979 | dracula, draculfp | supported |  |
| Hong Kong Phooey | Original | 2025 | wildfyre | supported |  |
| Hot Hand | Stern | 1979 | hothand | supported |  |
| Lectronamo | Stern | 1978 | lectrono | supported |  |
| Magic | Stern | 1979 | magic | supported |  |
| Memory Lane | Stern | 1978 | memlane | supported |  |
| Near Dark | Original | 2025 | dracula | supported |  |
| Nugent | Stern | 1978 | nugent | supported |  |
| Pinball (EM) | Stern | 1977 | pinball | supported |  |
| Pinball (SS) | Stern | 1977 | pinball | supported |  |
| Stars | Stern | 1978 | starsb7 unsupported (no map in pinmame-nvram-maps), starsb unsupported (no map in pinmame-nvram-maps), stars supported | supported |  |
| Stephen King's Pet Sematary | Original | 2019 | dracula | supported |  |
| Stingray | Stern | 1977 | stingray | supported |  |
| Trident | Stern | 1979 | trident | supported |  |
| Wild Fyre | Stern | 1978 | wildfyrc unsupported (no map in pinmame-nvram-maps), wildfyre supported | supported |  |

## bally-17-4K

0 verified, 10 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Black Jack (SS) | Bally | 1978 | blackjck | supported |  |
| Bobby Orr Power Play | Bally | 1978 | pwerplay | supported |  |
| Eight Ball | Bally | 1977 | eightbll | supported |  |
| Evel Knievel | Bally | 1977 | evelknie | supported |  |
| Hot Ball | Taito do Brasil | 1979 | eightbll supported, eightblo unsupported (no map in pinmame-nvram-maps) | supported |  |
| Mata Hari | Bally | 1978 | matahari | supported |  |
| Night Rider | Bally | 1976 | nightrdr | supported |  |
| Silver Bullet | Original | 2025 | matahari | supported |  |
| Strikes and Spares | Bally | 1978 | stk_sprs | supported |  |
| The Dude | Original | 2020 | stk_sprs | supported |  |

## williams-system11-40K

0 verified, 4 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Grand Lizard | Williams | 1986 | grand_l4 | supported |  |
| High Speed | Williams | 1986 | hs_p4g unsupported (no map in pinmame-nvram-maps), hs_l4 supported | supported |  |
| Monster Rancher | Original | 2019 | hs_l4 | supported |  |
| The Dukes of Hazzard | Original | 2022 | hs_l4 | supported |  |

## taito-1979

0 verified, 3 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Information Society | Original | 2025 | shock | supported |  |
| Shock | Taito do Brasil | 1979 | shock | supported |  |
| U2 Reskin | Original | 2025 | shock | supported |  |

## williams-system9-16K

0 verified, 3 supported, 1 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Comet | Williams | 1985 | comet_l5 | supported |  |
| Miami Vice | Original | 2020 | comet_l5 | supported |  |
| Space Shuttle | Williams | 1984 | sshtl_l7, sshuttle | supported |  |
| Gold Mine | Williams | 1988 | gmine_l2 | unsupported | williams-system9-16K: no game_over, current_ball, current_player in the map |

## bally-17-3K

0 verified, 2 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Freedom (EM) | Bally | 1976 | freedom | supported |  |
| Freedom (SS) | Bally | 1976 | freedom | supported |  |

## dataeast-v1

0 verified, 2 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Iron Maiden Virtual Time | Original | 2020 | lwar_a83 | supported |  |
| Laser War | Data East | 1987 | lwar_a83 | supported |  |

## capcom

0 verified, 1 supported, 4 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Big Bang Bar | Capcom | 1996 | bbb109 | supported |  |
| Airborne | Capcom | 1996 | abv106 | unsupported | capcom: no scores, game_over, current_ball, current_player in the map |
| Breakshot | Capcom | 1996 | bsv103 | unsupported | capcom: no scores, game_over, current_ball, current_player in the map |
| Kingpin | Capcom | 1996 | kpv106 | unsupported | capcom: no scores, game_over, current_ball, current_player in the map |
| The Untouchables | Original | 2023 | kpv106 | unsupported | capcom: no scores, game_over, current_ball, current_player in the map |

## gottlieb-system3-32K

0 verified, 1 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Lights...Camera...Action! | Gottlieb | 1989 | lca, lca2 | supported | ROM from pinmame-nvram-maps (VPS lists none) |

## rowamet

0 verified, 1 supported, 0 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Heavy Metal | Rowamet | 1981 | heavymtl | supported |  |

## alving

0 verified, 0 supported, 1 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Mystery Castle | Alvin G. | 1993 | mystcast | unsupported | alving: no scores, game_over, current_ball, current_player in the map |

## atari-gen1

0 verified, 0 supported, 4 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Airborne Avenger | Atari | 1977 | aavenger | unsupported | atari-gen1: scores, game_over, current_ball, current_player in CPU RAM |
| Middle Earth | Atari | 1978 | midearth | unsupported | atari-gen1: scores, game_over, current_ball, current_player in CPU RAM |
| Space Riders | Atari | 1978 | spcridef.zip unsupported (no map in pinmame-nvram-maps), spcrider.zip unsupported (no map in pinmame-nvram-maps), spcrider unsupported (atari-gen1: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | atari-gen1: scores, game_over, current_ball, current_player in CPU RAM |
| The Atarians | Atari | 1976 | atarians, atarianb unsupported (no map in pinmame-nvram-maps), atarians unsupported (atari-gen1: scores, game_over, current_ball, current_player in CPU RAM), atarianb unsupported (no map in pinmame-nvram-maps) | unsupported | atari-gen1: scores, game_over, current_ball, current_player in CPU RAM |

## atari-gen2

0 verified, 0 supported, 2 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Hercules | Atari | 1979 | hercules | unsupported | atari-gen2: game_over, current_ball, current_player in CPU RAM |
| Superman | Atari | 1979 | superman | unsupported | atari-gen2: game_over, current_ball, current_player in CPU RAM |

## gottlieb-system1

0 verified, 0 supported, 18 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Asteroid Annie and the Aliens | Gottlieb | 1980 | astannie | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Babylon 5 | Original | 2022 | genie | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM |
| Buck Rogers | Gottlieb | 1980 | buckrgrs | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM |
| Cleopatra (SS) | Gottlieb | 1977 | cleoptra | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Close Encounters of the Third Kind | Gottlieb | 1978 | closeenc | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM |
| Count-Down | Gottlieb | 1979 | countdwn | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| CowBoy Bebop | Original | 2024 | genie | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM |
| Genie | Gottlieb | 1979 | genie | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| John Carpenter's Christine | Original | 2019 | dragon | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM |
| Joker Poker (SS) | Gottlieb | 1978 | jokrpokr | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM |
| Pinball Pool | Gottlieb | 1979 | pinpool | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Roller Disco | Gottlieb | 1980 | roldisco | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Sinbad | Gottlieb | 1978 | sinbad, sinbadn | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Solar Ride | Gottlieb | 1979 | solaride | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Sultan | Taito do Brasil | 1979 | sinbadn | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM |
| The Way of the Dragon | Original | 2020 | sinbadn | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM |
| Torch | Gottlieb | 1980 | torch | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Totem | Gottlieb | 1979 | totem | unsupported | gottlieb-system1: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |

## gottlieb-system80-1prom

0 verified, 0 supported, 34 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Alien Star | Gottlieb | 1984 | alienstr | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Amazon Hunt | Gottlieb | 1983 | amazonh, amazonha | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Black Hole | Gottlieb | 1981 | blckhole | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Devil's Dare | Gottlieb | 1982 | dvlsdre, dvlsdre2, dvlsdrea | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Eclipse | Gottlieb | 1982 | eclipse, eclipse7 | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| El Bueno el Feo y el Malo | Original | 2015 | eldorado | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| El Dorado | Gottlieb | 1975 | eldorado | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| El Dorado City of Gold | Gottlieb | 1984 | eldorado | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Force II | Gottlieb | 1981 | forceii, forceii7 | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Ghosts 'n Goblins | Original | 2018 | pnkpnthr | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Goin' Nuts | Gottlieb | 1983 | goinnuts | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Haunted House | Gottlieb | 1982 | hh, hh7, hh_1, hh_3, hh_3a, hh_3b, hh_4, hh_4a, hh_4b | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Ice Fever | Gottlieb | 1985 | icefever | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Jacks to Open | Gottlieb | 1984 | jack2opn | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| James Bond 007 | Gottlieb | 1980 | jamesb | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Krull | Gottlieb | 1983 | krull | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Mars God of War | Gottlieb | 1981 | mars, mars7, mars_2, marsf, marsp | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Missing in Action | Original | 2018 | eldorado | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Panthera | Gottlieb | 1980 | panther7, panthera | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Pink Panther | Gottlieb | 1981 | pnkpnthr | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Punk! | Gottlieb | 1982 | punk | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Q-Bert's Quest | Gottlieb | 1983 | qbquest | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Rack 'Em Up! | Gottlieb | 1983 | rackemup | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Ready...Aim...Fire! | Gottlieb | 1983 | raimfire | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Rocky | Gottlieb | 1982 | rocky, rockyf | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Royal Flush Deluxe | Gottlieb | 1983 | rflshdlx, rflshdlx1 | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Spirit | Gottlieb | 1982 | spirit, spirit0, spirit3 | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Striker | Gottlieb | 1982 | striker, strikerf, strikerg | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Sublime | Original | 2025 | alienstr | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Super Orbit | Gottlieb | 1983 | sorbit | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Time Line | Gottlieb | 1980 | timelin7, timeline | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Touchdown | Gottlieb | 1984 | touchdn | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| TRON Classic | Original | 2018 | panther7 | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM |
| Volcano | Gottlieb | 1981 | vlcno_1a, vlcno_1b, vlcno_1c, vlcno_a7, vlcno_ax, vlcno_b7 | unsupported | gottlieb-system80-1prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |

## gottlieb-system80-2prom

0 verified, 0 supported, 4 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Circus | Gottlieb | 1980 | circus, circus7 | unsupported | gottlieb-system80-2prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Counterforce | Gottlieb | 1980 | cntforce, cntforc7 | unsupported | gottlieb-system80-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| Star Race | Gottlieb | 1980 | starrac7, starrace | unsupported | gottlieb-system80-2prom: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| The Amazing Spider-Man | Gottlieb | 1980 | spiderm7, spidermn | unsupported | gottlieb-system80-2prom: scores, game_over, current_ball, current_player in CPU RAM |

## gottlieb-system80b-10K

0 verified, 0 supported, 15 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Arena | Gottlieb | 1987 | arena, arena_fp, arenaa, arenaafp, arenaffp, arenagfp | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Diamond Lady | Gottlieb | 1988 | diamnffp, diamngfp, diamond, diamonfp | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Genesis | Gottlieb | 1986 | genesffp, genesgfp, genesifp, genesis | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Gold Wings | Gottlieb | 1986 | gldwgffp, gldwggfp, goldwgfp, goldwing | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Harley Quinn | Original | 2017 | diamond | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Hollywood Heat | Gottlieb | 1986 | hlywoodh | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Monte Carlo | Gottlieb | 1987 | mntcr2fp, mntcrafp, mntcrffp, mntcrfmfp, mntcrgfp, mntcrgmfp, mntcrmfp, mntecrfp, mntecrlo | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Predator | Original | 2026 | raven | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Rambo | Original | 2019 | raven | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Raven | Gottlieb | 1986 | raven | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Robo-War | Gottlieb | 1988 | robowars, robowffp, robowrfp | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Spring Break | Gottlieb | 1987 | sprbrafp, sprbreak, sprbrffp, sprbrgfp, sprbrkfp, sprbrsfp | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Tag-Team Pinball | Gottlieb | 1985 | tagteam, tagteam2, tagtem2f, tagtemfp, tagtmgfp | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| TX-Sector | Gottlieb | 1988 | txsecffp, txsecgfp, txsectfp, txsector | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Victory | Gottlieb | 1987 | victory, victr101, victr11, victr12, victr13, victrffp, victrgfp, victryfp | unsupported | gottlieb-system80b-10K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |

## gottlieb-system80b-12K

0 verified, 0 supported, 6 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Bad Girls | Gottlieb | 1988 | badgirls, badgrffp, badgrgfp, badgrlfp | unsupported | gottlieb-system80b-12K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Big House | Gottlieb | 1989 | bighosfp, bighouse, bighsffp, bighsgfp | unsupported | gottlieb-system80b-12K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Bone Busters Inc. | Gottlieb | 1989 | bonebffp, bonebgfp, bonebsfp, bonebstr | unsupported | gottlieb-system80b-12K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Excalibur | Gottlieb | 1988 | excalbfp, excalffp, excalgfp, excaliba, excalibr | unsupported | gottlieb-system80b-12K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Hot Shots | Gottlieb | 1989 | hotshffp, hotshgfp, hotshots, hotshtfp | unsupported | gottlieb-system80b-12K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Night Moves | International Concepts | 1989 | nmoves | unsupported | gottlieb-system80b-12K: scores, game_over, current_ball, current_player in CPU RAM |

## gottlieb-system80b-8K

0 verified, 0 supported, 5 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Bounty Hunter | Gottlieb | 1985 | bountgfp, bounthfp, bountyh | unsupported | gottlieb-system80b-8K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Chicago Cubs 'Triple Play' | Gottlieb | 1985 | triplay, triplgfp, triplyf1, triplyfp | unsupported | gottlieb-system80b-8K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Disney Vaiana | Original | 2021 | rock | unsupported | gottlieb-system80b-8K: scores, game_over, current_ball, current_player in CPU RAM |
| Rock | Gottlieb | 1985 | rock, rockfp, rockgfp | unsupported | gottlieb-system80b-8K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |
| Rock Encore | Gottlieb | 1986 | rock_efp, rock_enc, rockegfp | unsupported | gottlieb-system80b-8K: scores, game_over, current_ball, current_player in CPU RAM; ROM from pinmame-nvram-maps (VPS lists none) |

## stern-m200

0 verified, 0 supported, 45 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Ali | Stern | 1980 | alic unsupported (no map in pinmame-nvram-maps), ali unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Annabelle | Original | 2020 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Attack of the Killer Tomatoes | Original | 2023 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Bad Girls from Space | Original | 2026 | flight2k | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Beetlejuice | Original | 2023 | ironmaid | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Biene Maja | Original | 2022 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Big Game | Stern | 1980 | biggamef unsupported (no map in pinmame-nvram-maps), biggame unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Catacomb | Stern | 1981 | catacomb | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Cheetah | Stern | 1980 | cheetah84 unsupported (no map in pinmame-nvram-maps), cheetahb2 unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM), cheetah unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM), cheetah2 unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Class of 1984 | Original | 2024 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Disney Aladdin | Original | 2020 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Disney Hotel Transylvania | Original | 2021 | viper | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Dragonfist | Stern | 1981 | dragfis17 unsupported (no map in pinmame-nvram-maps), dragfis16 unsupported (no map in pinmame-nvram-maps), dragfis15 unsupported (no map in pinmame-nvram-maps), dragfist unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Evil Dead 2 | Original | 2019 | ironmaid | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Flight 2000 | Stern | 1980 | flight2k | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Freefall | Stern | 1981 | freefall | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Frozen Butterfly | Original | 2026 | biggamef unsupported (no map in pinmame-nvram-maps), biggame unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Galaxy | Stern | 1980 | galaxy | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Gamatron | Sonic | 1986 | flight2m | unsupported | stern-m200: no scores, game_over, current_ball, current_player in the map |
| Gollum - The Rings of Power Edition | Original | 2023 | lightnin | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Howl Against The Chains - Lunar Howl 2 | Original | 2025 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Iron Maiden | Stern | 1982 | ironmaid | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| John Carpenter's The Thing | Original | 2019 | ali | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| JP's Seawitch | Stern | 1980 | seawitchf unsupported (no map in pinmame-nvram-maps), seawitche unsupported (no map in pinmame-nvram-maps), seawitch unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Killzone | Original | 2019 | freefall | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Lightning | Stern | 1981 | lightnid unsupported (no map in pinmame-nvram-maps), lightnin unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Magnum P.I.nBall | Original | 2020 | quicksil | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Meteor | Stern | 1979 | meteor unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM), meteorb.zip unsupported (no map in pinmame-nvram-maps) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Midnight Resistance | Original | 2020 | lightnin | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Nine Ball | Stern | 1980 | nineball | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Oasis Knebworth | Original | 2023 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Orbitor 1 | Stern | 1982 | orbitor1 | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Quick! Silver! - A Rush For Riches | Original | 2025 | quicksil | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Quicksilver | Stern | 1980 | quicksic unsupported (no map in pinmame-nvram-maps), quicksil unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Seawitch | Stern | 1980 | seawitchf unsupported (no map in pinmame-nvram-maps), seawitche unsupported (no map in pinmame-nvram-maps), seawitch unsupported (stern-m200: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Split Second | Stern | 1981 | splitsec | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Star Gazer | Stern | 1980 | stargzr | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Stephen King's The Running Man | Original | 2019 | cheetah | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Taxi Driver | Original | 2024 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| The Beatles | Stern | 2018 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| The Fly | Original | 2023 | freefall | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| The Lord of the Rings - The Rings of Power | Original | 2022 | lightnin | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Tripping Tractors | Original | 2025 | splitsec | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| U2 360 | Original | 2025 | seawitch | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |
| Viper | Stern | 1981 | viper | unsupported | stern-m200: scores, game_over, current_ball, current_player in CPU RAM |

## williams-system4-2prom

0 verified, 0 supported, 9 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Bella Dama | Original | 2023 | httip_l1 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| Contact | Williams | 1978 | cntct_l1 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| Disco Fever | Williams | 1978 | disco_l1 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| Hot Tip | Williams | 1977 | httip_l1 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| Lucky Seven | Williams | 1978 | lucky_l1 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| Pepsi Man | Original | 2019 | wldcp_l1 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| Phoenix | Williams | 1978 | phnix_l1 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| Stellar Wars | Williams | 1979 | stlwr_l2 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |
| World Cup | Williams | 1978 | wldcp_l1 | unsupported | williams-system4-2prom: scores, game_over, current_ball, current_player in CPU RAM |

## williams-system4-3prom

0 verified, 0 supported, 1 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Pokerino | Williams | 1978 | pkrno_l1 | unsupported | williams-system4-3prom: scores, game_over, current_ball, current_player in CPU RAM |

## williams-system6-6K

0 verified, 0 supported, 22 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Accept | Original | 2019 | algar_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Algar | Williams | 1980 | algar_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Alien Poker | Williams | 1980 | alpok_l6 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Batman '66 | Original | 2018 | flash_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Battlestar Galactica | Original | 2018 | scrpn_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Blackout | Williams | 1980 | blkou_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Cobra | Original | 2022 | blkou_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Disney The Lion King | Original | 2020 | alpok_l6 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Flash | Williams | 1979 | flash_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Gorgar | Williams | 1979 | grgar_l2 unsupported (no map in pinmame-nvram-maps), grgar_l1 unsupported (williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM) | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Laser Ball | Williams | 1979 | lzbal_l2 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Manowar | Original | 2019 | alpok_l6 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Marilyn Monroe Tribute | Original | 2022 | flash_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Motörhead | Original | 2018 | blkou_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Pain | Original | 2025 | blkou_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Scorpion | Williams | 1980 | scrpn_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Sister Storm - Lunar Howl 7 | Original | 2026 | alpok_l6 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Star Tours | Original | 2024 | alpok_l2, alpok_l6 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Star Wars | Original | 2019 | alpok_l6 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| The Flash | Original | 2018 | flash_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Time Warp | Williams | 1979 | tmwrp_l2 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |
| Tri Zone | Williams | 1979 | trizn_l1 | unsupported | williams-system6-6K: scores, game_over, current_ball, current_player in CPU RAM |

## williams-system7-10K

0 verified, 0 supported, 42 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Alien Resurrection | Original | 2019 | jngld_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Barracora | Williams | 1981 | barra_l1 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Beastie Boys | Original | 2025 | barra_l1 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Black Knight | Williams | 1980 | bk_l4 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Black Tiger Pinball | Original | 2022 | pharo_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Blaze and the Monster Machines | Original | 2021 | csmic_l1 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Bloodsport | Original | 2023 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Bon Jovi | Original | 2024 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Commando - Schwarzenegger | Original | 2019 | csmic_l1 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Cosmic Gunfight | Williams | 1982 | csmic_l1 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Daho | Original | 2024 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Firepower II | Williams | 1983 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Friday the 13th Part II | Original | 2019 | pharo_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Indestructible Pack - Lunar Howl 4 | Original | 2026 | barra_l1 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Iron Maiden | Original | 2025 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Jack Daniel's | Original | 2020 | wrlok_l3 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Jack Daniel's 2 | Original | 2021 | wrlok_l3 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Joust | Williams | 1983 | jst_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Judas Priest | Original | 2024 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Jungle Lord | Williams | 1981 | jngld_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Kat & Roman Kostrzewski | Original | 2023 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Laser Cue | Williams | 1984 | lsrcu_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Mask | Original | 2023 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Pharaoh | Williams | 1981 | pharo_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Predator 2 | Original | 2019 | wrlok_l3 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Rainbow | Original | 2025 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Rammstein - Fire & Power | Original | 2023 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Saw | Original | 2022 | tmfnt_l5 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Scorpions | Original | 2024 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Simple Minds | Original | 2024 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Slash | Original | 2025 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Slash's Snakepit It's Five O'clock Somewhere | Original | 2025 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Solar Fire | Williams | 1981 | solar_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Space 1999 | Original | 2025 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Stephen King's Children of the Corn | Original | 2019 | tmfnt_l5 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Tango & Cash | Original | 2019 | barra_l1 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Taylor Swift | Original | 2021 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Tenacious D | Original | 2025 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| The Witcher | Original | 2020 | csmic_l1 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Time Fantasy | Williams | 1983 | tmfnt_l5 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Warlok | Williams | 1982 | wrlok_l3 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |
| Wiedzmin | Original | 2024 | fpwr2_l2 | unsupported | williams-system7-10K: scores, game_over, current_ball, current_player in CPU RAM |

## williams-system7-12K

0 verified, 0 supported, 5 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Defender | Williams | 1982 | dfndr_l4 | unsupported | williams-system7-12K: scores, game_over, current_ball, current_player in CPU RAM |
| Hyperball | Williams | 1981 | hypbl_l6 | unsupported | williams-system7-12K: scores, game_over, current_ball, current_player in CPU RAM |
| Star Light | Williams | 1984 | strlt_l1 | unsupported | williams-system7-12K: scores, game_over, current_ball, current_player in CPU RAM |
| Transformers - The Movie 1986 | Original | 2019 | dfndr_l4 | unsupported | williams-system7-12K: scores, game_over, current_ball, current_player in CPU RAM |
| Yello Pinball Cha Cha | Original | 2021 | dfndr_l4 | unsupported | williams-system7-12K: scores, game_over, current_ball, current_player in CPU RAM |

## zaccaria-gen1

0 verified, 0 supported, 3 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| House of Diamonds | Zaccaria | 1978 | hod | unsupported | zaccaria-gen1: no game_over, current_ball, current_player in the map |
| Shooting the Rapids | Zaccaria | 1979 | strapids | unsupported | zaccaria-gen1: no game_over, current_ball, current_player in the map |
| Star God | Zaccaria | 1980 | stargoda unsupported (zaccaria-gen1: no game_over, current_ball, current_player in the map), stargodb unsupported (no map in pinmame-nvram-maps), stargod unsupported (no map in pinmame-nvram-maps) | unsupported | zaccaria-gen1: no game_over, current_ball, current_player in the map |

## zaccaria-gen2

0 verified, 0 supported, 8 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| Devil Riders | Zaccaria | 1984 | dvlrider | unsupported | zaccaria-gen2: no game_over, current_ball, current_player in the map |
| Farfalla | Zaccaria | 1983 | farfalla | unsupported | zaccaria-gen2: no game_over, current_ball, current_player in the map |
| Magic Castle | Zaccaria | 1984 | mcastle | unsupported | zaccaria-gen2: no game_over, current_ball, current_player in the map |
| Pinball Champ '82 | Zaccaria | 1982 | pinchamp | unsupported | zaccaria-gen2: no game_over, current_ball, current_player in the map |
| Robot | Zaccaria | 1985 | robot | unsupported | zaccaria-gen2: no game_over, current_ball, current_player in the map |
| Soccer Kings | Zaccaria | 1982 | socrkin2 unsupported (no map in pinmame-nvram-maps), socrking unsupported (zaccaria-gen2: no game_over, current_ball, current_player in the map) | unsupported | zaccaria-gen2: no game_over, current_ball, current_player in the map |
| The Grinch's How to Steal Christmas | Original | 2025 | robot | unsupported | zaccaria-gen2: no game_over, current_ball, current_player in the map |
| Time Machine | Zaccaria | 1983 | tmachzac | unsupported | zaccaria-gen2: no game_over, current_ball, current_player in the map |

## No map (no ROM, or no map for its ROMs)

0 verified, 0 supported, 1677 unsupported.

| Game | Manufacturer | Year | ROMs | Status | Reason |
|---|---|---:|---|---|---|
| !WOW! | Mills Novelty Company | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| '300' | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 'Roid Belt Racers | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 1-2-3 | Automaticos | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 2 in 1 | Bally | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 2001 | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 2001 - A Space Odyssey | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 250 cc | Inder | 1992 | ind250cc | unsupported | no map in pinmame-nvram-maps |
| 3-In-Line | Bally | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 301 Bullseye | Grand Products | 1986 | bullsen2, bullsey2, bullseyn, bullseye | unsupported | no map in pinmame-nvram-maps |
| 4 Aces | Williams | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 4 Queens | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 4 Roses | Williams | 1962 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 4 Square | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| 4X4 | Atari | 1983 | fourx4 | unsupported | no map in pinmame-nvram-maps |
| 8 Ball | Williams | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| A Charlie Brown Christmas | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| A Christmas Carol Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| A-Go-Go | Williams | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| A-ha | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Abra Ca Dabra | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| AC/DC | Original | 2012 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| AC/DC Power Up | Original | 2022 | acd_170c. | unsupported | no map in pinmame-nvram-maps |
| Ace High | Gottlieb | 1957 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aces & Kings | Williams | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aces High | Bally | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Adventure | Sega | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Adventure Time - Rainy Day Daydream | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aerobatics | Zaccaria | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aerosmith | Original | 2019 | frpwr_b7 | unsupported | no map in pinmame-nvram-maps |
| Aerosmith (Pro) | Stern | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Agents 777 | Game Plan | 1984 | agent777 | unsupported | no map in pinmame-nvram-maps |
| AIQ | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Air Aces | Bally | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Airborne | J. Esteban | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Airport | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Akira | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Al Capone | LTD do Brasil | 1984 | alcapone | unsupported | no map in pinmame-nvram-maps |
| Al's Garage Band Goes on a World Tour | Alvin G. | 1992 | wrldtou4, wrldtou3, wrldtou2 | unsupported | no map in pinmame-nvram-maps |
| Aladdin | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aladdin's Castle | Bally | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alaska | Interflip | 1978 | r_alaska | unsupported | no map in pinmame-nvram-maps |
| Albator | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alcatrazz | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alice Cooper's Nightmare Castle | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alice in Chains Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alice in Wonderland | Gottlieb | 1948 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alien | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alien Covenant | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alien Trilogy | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alien Warrior | LTD do Brasil | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aliens from Outer Space | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alive | Brunswick | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alley Cats | Williams | 1985 | alcat_l7 | unsupported | no map in pinmame-nvram-maps |
| Aloha | Gottlieb | 1961 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Alvin and the Chipmunks | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Amazon | LTD do Brasil | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| America 1492 | Juegos Populares | 1986 | america | unsupported | no map in pinmame-nvram-maps |
| America's Most Haunted | Spooky Pinball | 2014 | amh_022, amh_023 | unsupported | no map in pinmame-nvram-maps |
| American Country | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| American Dad | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| American Graffiti | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Amigo | Bally | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Amy Winehouse | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Andromeda | Game Plan | 1985 | andromed | unsupported | no map in pinmame-nvram-maps |
| Animal | Original | 2017 | glxplay | unsupported | no map in pinmame-nvram-maps |
| Animal Crossing Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Antar | Playmatic | 1979 | antar2 | unsupported | no map in pinmame-nvram-maps |
| Antworld | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Apache | Playmatic | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Apache! | Taito do Brasil | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Apollo | Williams | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aqualand | Juegos Populares | 1986 | aqualand | unsupported | no map in pinmame-nvram-maps |
| Aquaman | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aquarius | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Argosy | Williams | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aristocrat | Williams | 1979 | arist_l1 | unsupported | no map in pinmame-nvram-maps |
| Arizona | LTD do Brasil | 1977 | arizona | unsupported | no map in pinmame-nvram-maps |
| Army of the Dead | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aspen | Brunswick | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Asterix the Twelve Tasks | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Asteroids | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Astral Defender | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Astro | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Astronaut | Chicago Coin | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Atari 2600 | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Atari Centipede Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Atlantis | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Atlantis | LTD do Brasil | 1978 | atla_ltd | unsupported | no map in pinmame-nvram-maps |
| Atlantis | Bally | 1989 | atlantis | unsupported | no map in pinmame-nvram-maps |
| Atleta | Inder | 1991 | atleta | unsupported | no map in pinmame-nvram-maps |
| Atomic | Tomy | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Attack | Playmatic | 1980 | attack | unsupported | no map in pinmame-nvram-maps |
| Attack on Titan | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Attila the Hun | Game Plan | 1984 | attila | unsupported | no map in pinmame-nvram-maps |
| Avatar - The Last Airbender | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Avenged Sevenfold | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Aztec | Williams | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| B.B. King | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Baby Leland | Stoner | 1933 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Baby Pac-Man | Bally | 1982 | babypac | unsupported | no map in pinmame-nvram-maps |
| Baby Shark | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Baby Sharpshooter | Game Plan | 1985 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Back to the Future Trilogy | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bad | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bad Cats In Space | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bad Lieutenant | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bad Santa 2 Pinball XL | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bad Santa Pinball | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Balls-A-Poppin | Bally | 1956 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bally Hoo | Bally | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ballyhoo | Bally | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Band Wagon | Bally | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bank Shot | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bank-A-Ball | J.F. Linck | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bank-A-Ball | Gottlieb | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Barbarella | Automaticos | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Barnstorming | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Barry Manilow | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bart vs. the Space Mutants | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Baseball | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Basketball | IDSA | 1986 | bsktball | unsupported | no map in pinmame-nvram-maps |
| Bass on Bass | Original | 2026 | macgalaxy | unsupported | no map in pinmame-nvram-maps |
| Bat-Em | In & Outdoor | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Batgirl | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Batman - The Animated Series | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Batman (66 Premium) | Stern | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Batman Returns | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Batman Returns | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Batter Up | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Beach Boys | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Beach Bums | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Beach Goblinball | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Beat the Clock | Bally | 1985 | beatclc2, beatclck | unsupported | no map in pinmame-nvram-maps |
| Beat Time | Williams | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Beavis and Butt-Head Pinball Stupidity | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Beavis and Butt-Head Pinballed | Original | 2024 | beav_butt | unsupported | no map in pinmame-nvram-maps |
| Beetlejuice | Original | 2021 | strngsci | unsupported | no map in pinmame-nvram-maps |
| Beetlejuice Beetlejuice | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Beisbol | Maresa | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bell Ringer | Gottlieb | 1990 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ben Hur | Staal | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Berzerk | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Beverly Hills Cop | Original | 2019 | faeton | unsupported | no map in pinmame-nvram-maps |
| Beyond The Gate - Lunar Howl 11 | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Ben | Williams | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Brave | Maresa | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Brave | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Casino | Gottlieb | 1961 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Chief | Williams | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Deal | Williams | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Deal | Williams | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Dick | Fabulous Fantasies | 1996 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Flush | LTD do Brasil | 1983 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Game | Rock-ola | 1935 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Hit | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Horse | Maresa | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Indian | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Injun | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Shot | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Show | Bally | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Star | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Top | Gottlieb | 1988 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Town | Playmatic | 1978 | bigtown | unsupported | no map in pinmame-nvram-maps |
| Big Trouble in Little China | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Trouble in Little China | Original | 2022 | canasta | unsupported | no map in pinmame-nvram-maps |
| Big Trouble in Little China | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Big Valley | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Biker Mice from Mars | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Billy Idol | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bird Fly | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Black & Red | Inder | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Black Belt | Bally | 1986 | blackblt | unsupported | no map in pinmame-nvram-maps |
| Black Fever | Playmatic | 1980 | blkfever | unsupported | no map in pinmame-nvram-maps |
| Black Gold | Williams | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Black Hole | LTD do Brasil | 1982 | bhol_ltd | unsupported | no map in pinmame-nvram-maps |
| Black Knight Sword of Rage | Stern | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Black Magic 4 | Recel | 1980 | r_blackm4 | unsupported | no map in pinmame-nvram-maps |
| Black Sabbath the '70s | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Black Sheep Squadron | Astro Games | 1979 | blkshpsq | unsupported | no map in pinmame-nvram-maps |
| Black Velvet | Game Plan | 1978 | blvelvet | unsupported | no map in pinmame-nvram-maps |
| Blackwater 100 | Bally | 1988 | black100 | unsupported | no map in pinmame-nvram-maps |
| Blade Runner 2049 | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Blank Table with Scoring | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bleach | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Blink 182 | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Blood Machines | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bloodsport | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Blue Chip | Williams | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Blue Max | Chicago Coin | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Blue Note | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Blue Ribbon | Bally | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bluey | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bob Marley | Original | 2024 | snake.zip | unsupported | no map in pinmame-nvram-maps |
| Bob Seger | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bob's Burgers | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bon Voyage | Bally | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bonanza | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bond 60th | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bond 60th (Limited Edition) | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Boomerang | Bally | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Boop-A-Doop | Pace | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Border Town | Gottlieb | 1940 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Borderlands | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Boston | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bow and Arrow (EM) | Bally | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bow and Arrow (SS) | Bally | 1974 | bowarrow | unsupported | no map in pinmame-nvram-maps |
| Bowie Star Man | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bowl-O | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bowling - Alle Neune | NSM | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Brainscan | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Brave Team | Inder | 1985 | brvteam | unsupported | no map in pinmame-nvram-maps |
| Bravestarr | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Break | Video Dens | 1986 | break | unsupported | no map in pinmame-nvram-maps |
| Breakin | Original | 2025 | break | unsupported | no map in pinmame-nvram-maps |
| Breaking Bad | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Breaking Bad | Original | 2022 | strngsci | unsupported | no map in pinmame-nvram-maps |
| Bristol Hills | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Britney Spears | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bronco | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bruce Lee | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bubba the Redneck Werewolf | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Buccaneer | Gottlieb | 1948 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Buccaneer | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Buccaneer | J. Esteban | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Buckaroo | Gottlieb | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bud Spencer & Terence Hill | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Buffy the Vampire Slayer | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bugs and Jokers | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bumper | Bill Port | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bumper Pool | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bunnyboard | Marble Games | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Burner | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Bushido | Inder | 1993 | bushidoa | unsupported | no map in pinmame-nvram-maps |
| C.O.D. | Williams | 1953 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Caballeros del Zodiaco | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cabaret | Williams | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cactus Canyon Continued | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Caddie | Playmatic | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Camel Lights | Game Plan | 1978 | camlight | unsupported | no map in pinmame-nvram-maps |
| Camelot | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Camping Trip! | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Canada Dry | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Canasta 86 | Inder | 1986 | canasta | unsupported | no map in pinmame-nvram-maps |
| Cannes | Segasa | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cannon Fodder | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Capersville | Bally | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Capt. Card | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Capt. Fantastic and the Brown Dirt Cowboy | Bally | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Captain NEMO Dives Again | Quetzal Pinball | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Captain Spaulding's Museum of Monsters and Madmen | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Carcariass Pinball Chaos | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Card King | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Card Trix | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Card Whiz | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Carnaval no Rio | LTD do Brasil | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Carnival Games | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Carnival Queen | Bally | 1958 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Carrie Underwood | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| CARtoons RC | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Casino | Williams | 1958 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Castlevania - Symphony of the Night | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cat Burglars | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cattanooga Cats | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cavalcade | Stoner | 1935 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cavalier | Recel | 1979 | r_cavalier | unsupported | no map in pinmame-nvram-maps |
| Caveman | Gottlieb | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cenobite | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Centigrade 37 | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Central Park | Gottlieb | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cerberus | Playmatic | 1983 | cerberus.zip | unsupported | no map in pinmame-nvram-maps |
| Champ | Bally | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Champions League - Libertadores narracao Brasileira | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Champions League - Season 2017 | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Champions League - Season 2018 | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Champions League - Season 2018 (St. Pauli) | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Champions League - Season 2020 | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Champions League - Season 2023 | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Champions League 2021 | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Chance | Playmatic | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Chance | Playmatic | 1978 | chance | unsupported | no map in pinmame-nvram-maps |
| Charlie Brown Baseball | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Charlie's Angels | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Charlie's Angels | Gottlieb | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Check | Recel | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Check Mate | Taito do Brasil | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Check Mate | Recel | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cheese Squad | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cheese Squad 2 | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Chef-ball | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cherry Coke | Original | 2020 | skatebrd | unsupported | no map in pinmame-nvram-maps |
| Child's Play | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Child's Play | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Chime Speed Test Table | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Chris Cornell | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Christmas Vaction | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Chrono Trigger | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Chuck-A-Luck | Game Plan | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cinema | Chicago Coin | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Circa 1933 | Allied Leisure | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Circus | Bally | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Circus | Zaccaria | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Circus | Brunswick | 1980 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| City Hunter | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| City on the Moon - Murray Leinster | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| City Ship | J. Esteban | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| City Slicker | Bally | 1987 | cityslck | unsupported | no map in pinmame-nvram-maps |
| Clever & Smart | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Clock of Eternal Fog | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Clockwork Orange | Original | 2022 | lortium | unsupported | no map in pinmame-nvram-maps |
| Cloudy with a Chance of Meatballs | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Clown | Inder | 1988 | pinclown | unsupported | no map in pinmame-nvram-maps |
| Clown | Playmatic | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Clue | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Clutch | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cobra | Playbar | 1987 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cobra | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cobra | Nuova Bell Games | 1987 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cobretti | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Coldplay Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| College Queens | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Columbia | LTD do Brasil | 1983 | columbia | unsupported | no map in pinmame-nvram-maps |
| Combination Rotation | Gottlieb | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Comic Book Guy | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Comics | Rally | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Concorde | Emagar | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Conjury Contraption | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Conquest 200 | Playmatic | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Contact Master | PAMCO | 1934 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Contest | Gottlieb | 1958 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Contra | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Copa Libertadores 2018 | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Corinthian Master Bagatelle | Abbey | 1951 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Coronation | Gottlieb | 1952 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Corsario | Inder | 1989 | corsario | unsupported | no map in pinmame-nvram-maps |
| Cosmic Carnival | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cosmic Lady | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cosmic Venus | Tilt Movie | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Courage The Cowardly Dog Pinball | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cow Poke | Gottlieb | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cowboy Bebop Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cowboy Eight Ball | LTD do Brasil | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cowboy Eight Ball 2 | LTD do Brasil | 1981 | cowboy | unsupported | no map in pinmame-nvram-maps |
| Crash Bandicoot | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Crazy Cats Demo Derby | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Crazy Rocket | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Creepshow | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Crescendo | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Criterium 75 | Recel | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Criterium 77 | Taito do Brasil | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cross Town | Gottlieb | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Crysis | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Crystal Palace Hotel | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Crystal-Ball | Automaticos | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cue | Stern | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cuphead | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cuphead Pro (Perdition Edition) | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Curling | Rally | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cyber Race | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Cyclopes | Game Plan | 1985 | cyclopes | unsupported | no map in pinmame-nvram-maps |
| Daft Punk | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Daft Punk - Interstella 5555 | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Daniel Tiger's Neighborhood | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dante's Inferno | Original | 2022 | nemesis | unsupported | no map in pinmame-nvram-maps |
| Daredevil and the Defenders | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dark (1986) | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dark Chaos | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dark Princess | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dark Shadow | Nuova Bell Games | 1986 | darkshad | unsupported | no map in pinmame-nvram-maps |
| Darkest Dungeon | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Darling | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Daughtry | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Days of Thunder | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dealer's Choice | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Death Note | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Def Leppard | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Deftones | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Delta Queen | Bally | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Demogorgon | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Demon Slayer | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dennis Lillee's Howzat! | Hankin | 1980 | howzat | unsupported | no map in pinmame-nvram-maps |
| Depeche Mode Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Derby Day | Gottlieb | 1956 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Desert City | Fipermatic | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dexter | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Diablo 2 | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Diablo Pinball | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Diadem | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Diamond Jack | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Diana | Rowamet | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Die Hard Trilogy | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dimension | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dimmu Borgir | Original | 2019 | frpwr_b7 | unsupported | no map in pinmame-nvram-maps |
| Dipsy Doodle | Williams | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disco | Stern | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disco Dancing | LTD do Brasil | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Discotek | Bally | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Descendants | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Encanto | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Frozen | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Moana | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Pin-Up Pinball | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Pixar Brave | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Pixar Luca | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Princesses | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Raya and Friends Pinball | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney Tangled | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Disney The Little Mermaid | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dixieland | Bally | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Django Unchained | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| DOF Test Table | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dogelon Mars Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dogies | Bally | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dolphin | Chicago Coin | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dominatrix | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Domino | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Domino | Gottlieb | 1983 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Doodle Bug | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Doom Classic Edition | Original | 2019 | madrace | unsupported | no map in pinmame-nvram-maps |
| Doom Eternal | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Doraemon | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Double Barrel | Williams | 1961 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Double Dragon Neon | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Double-Up | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dr. Rollover's Laboratory | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragon | Interflip | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragon | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragon (SS) | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragon Ball Z | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragon Ball Z Budokai | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragon Flames | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragon's Lair | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragonball - Super Saiyan Edition | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragonette | Gottlieb | 1954 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| DragonFire | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dragoon | Recreativos Franco | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dready 4-Bushes | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dream Daddy - The Dad Dating Simulator | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dream Theater | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| DreamWorks Megamind | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| DreamWorks Trolls | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Drink Absolut | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Drop-A-Card | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Drunken Santa | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| DuckTales | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dune | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dungeons & Dragons | Bally | 1987 | dungdrag | unsupported | no map in pinmame-nvram-maps |
| Duotron | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Duran Duran | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Dutch Pool | A.B.T. | 1931 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Eager Beaver | Williams | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Earth Wind Fire | Zaccaria | 1981 | ewf | unsupported | no map in pinmame-nvram-maps |
| Eddie | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Egg Head | Gottlieb | 1961 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Eight Ball Champ | Bally | 1985 | eballchp | unsupported | no map in pinmame-nvram-maps |
| El Duderino | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| El Toro | Bally | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Electra-Pool | Gottlieb | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Electric Mayhem | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Elf Pinball XL | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Elijah's Batman Pinball | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Elite Guard | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Elton John | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Elvis Gold (Limited Edition) | Stern | 2004 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Eminem | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Eros One | Fascination | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Escape from Monkey Island | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Escape from New York | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Escape from the Lost World | Bally | 1988 | esclwrld | unsupported | no map in pinmame-nvram-maps |
| Estopa | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Europe | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Evanescence | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Evel Knievel | Bally | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Everquest II Pinball Tribute | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Evil Dead | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Evil Dead 2 | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Evil Dead 3 Army of Darkness | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Evil Fight | Playmatic | 1980 | evlfight.zip | unsupported | no map in pinmame-nvram-maps |
| Experiments of Alchemical Chaos | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Expressway | Bally | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Extremoduro Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Eye of the Beholder Pinball | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Eye Of The Tiger | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Faces | Sonic | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Faeton | Juegos Populares | 1985 | faeton | unsupported | no map in pinmame-nvram-maps |
| Fair Fight | Recel | 1978 | r_fairfght | unsupported | no map in pinmame-nvram-maps |
| Fairy Favors | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Falling In Reverse | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Family Fun! | Game Plan | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Family Guy Christmas | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fan-Tas-Tic | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Far Cry 3 - Blood Dragon | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Far Out | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Farwest | Fliperbol | 1980 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fashion Show | Gottlieb | 1962 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fast Draw | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fast Times | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fear and Loathing | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Feiseanna | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Feiseanna II - Dream Worlds | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fifteen | Inder | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fight Night | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fire Queen | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fireball | Bally | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fireball XL5 | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Firecracker | Bally | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Firepower | Williams | 1980 | frpwr_c7, frpwr_b7, frpwr_b6 | unsupported | no map in pinmame-nvram-maps |
| Firepower vs. A.I. | Williams | 1980 | frpwr_c7 | unsupported | no map in pinmame-nvram-maps |
| Fireworks Mania | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Five Finger Death Punch | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Five Nights at Freddy's | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Five Nights at Freddy's Pizza Party | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| FJ | Hankin | 1978 | fjholden | unsupported | no map in pinmame-nvram-maps |
| Flame of Athens | Allied Leisure | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flash Dragon | Playmatic | 1986 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flashman | Sport matic | 1984 | flashman | unsupported | no map in pinmame-nvram-maps |
| Fleet Jr. | Bally | 1934 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fleetwood Mac | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flicker | Bally | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flip a Card | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flip Flop | Bally | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flipper Fair | Gottlieb | 1961 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flipper Football | Capcom | 1996 | ffv104 | unsupported | no map in pinmame-nvram-maps |
| Flipper Pool | Gottlieb | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Floopy Bat | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flying Carpet | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flying Chariots | Gottlieb | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Flying Turns | Midway | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Foo Fighters | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Football | Taito do Brasil | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Force | LTD do Brasil | 1979 | force | unsupported | no map in pinmame-nvram-maps |
| Foreigner | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Forge | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Forrest Gump | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fortnite | Original | 2024 | superman.zip | unsupported | no map in pinmame-nvram-maps |
| Four Million B.C. | Bally | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Four Seasons | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Foxy Lady | Game Plan | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Frank Thomas' Big Hurt | Gottlieb | 1995 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Freddy's Nightmares | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Free Fall | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Friday the 13th | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Friday the 13th | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| From Dusk Till Dawn | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Frozen North - Lunar Howl 8 | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Full | Recreativos Franco | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Full House | Williams | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Full Metal Jacket | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Full Throttle | Original | 2023 | ind250cc | unsupported | no map in pinmame-nvram-maps |
| Fullmetal Alchemist | Original | 2007 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fun Fair | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fun Land | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fun Park | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Fun-Fest | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Futurama | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Future World | Zaccaria | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Galaga Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Galahad | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Galaxia | LTD do Brasil | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Galaxie | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Galaxy | Sega | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Galaxy Play | CIC Play | 1986 | glxplay | unsupported | no map in pinmame-nvram-maps |
| Gamatron | Pinstar | 1985 | gamatron | unsupported | no map in pinmame-nvram-maps |
| Gamblin Daze | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Game Of Dog | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Game of Thrones | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Game of Thrones (Limited Edition) | Stern | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gargamel Park | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gaucho | Gottlieb | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gay 90's | Williams | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| GEEGA | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gemini | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Genesis | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| George Michael - Faith | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Get Smart | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ghost Ramps and DMD Test | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ghost Toys VPX Model Pack | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ghostbusters (Limited Edition) | Stern | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gigi | Gottlieb | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gnome Slayer Yuki | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Godzilla vs. Kong | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gold Crown | Pierce | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gold Rush | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gold Star | Gottlieb | 1954 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gold Strike | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Golden Arrow | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Golden Axe | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Golden Birds | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Golden Cue | Sega | 1998 | goldcue | unsupported | no map in pinmame-nvram-maps |
| Goldorak | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| GoldWing | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gorillaz | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gradius | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Grand Casino | J.P. Seeburg | 1934 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Grand Prix | LTD do Brasil | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Grand Prix | Williams | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Grand Slam | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Grand Tour | Bally | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Grande Domino | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Granny and the Gators | Bally | 1984 | granny | unsupported | no map in pinmame-nvram-maps |
| Grateful Dead | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Great Houdini | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Green Day - American Idiot | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Green Day - Dookie | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Green Lantern | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Green Pastures | Gottlieb | 1954 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gremlins | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gremlins Pinball | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gridiron | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Grillshow The Pinball Adventure | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Groovy | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Guardians of the Galaxy (Pro) | Stern | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Guardians of the Galaxy Trilogy | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gulfstream | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gun Men | Staal | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gundam Wing | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gwendoline's Mission | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gwendoline's Mission 2 - Travelling Still | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Gwendoline's Mission3 - Staring At The Crack | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hairy-Singers | Rally | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Half-Life | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hall & Oates | Original | 2025 | wolfman | unsupported | no map in pinmame-nvram-maps |
| Halley Comet | Juegos Populares | 1986 | halleyb, halley | unsupported | no map in pinmame-nvram-maps |
| Halloween | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Halloween | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Halloween Michael Myers Pinball Adventures | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Halo | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hamilton | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hanafuda Garden | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hang Glider | Bally | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hank Williams Pinball | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hannibal Lecter | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hans Zimmer | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Happy Tree Friends X-mas Pinball | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hardbody | Bally | 1987 | hardbody | unsupported | no map in pinmame-nvram-maps |
| Harley-Davidson | Stern | 2002 | 3.00 | unsupported | no map in pinmame-nvram-maps |
| Harmony | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Harry Potter and the Goblet of Fire | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Harry Potter and the Prisoner of Azkaban | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Harvest Frenzy | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Haunted Hotel | LTD do Brasil | 1983 | hhotel | unsupported | no map in pinmame-nvram-maps |
| Hayburners | Williams | 1951 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Headless Horseman | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hearts and Spades | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hearts Gain | Inder | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Heat Ray Heist | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Heat Wave | Williams | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Heavy Fire | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Heavy Metal Meltdown | Bally | 1987 | hvymetal | unsupported | no map in pinmame-nvram-maps |
| Heavy Metal Remastered | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hell Hound | Original | 2026 | cerberus | unsupported | no map in pinmame-nvram-maps |
| Hellboy Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hellfire | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hellraiser | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hextech | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hi-Deal | Bally | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hi-Diver | Gottlieb | 1959 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hi-Lo | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hi-Lo Ace | Bally | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hi-Score | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hi-Score Pool | Chicago Coin | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hi-Skor | Hi-Skor | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| High Hand | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| High Seas | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Highlander | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hill Climb | Gottlieb | 1983 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hiphop | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hit the Deck | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hokus Pokus | Bally | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hollywood | Chicago Coin | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Home Alone | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Home Alone | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Home Alone 2 | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Home Run | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Honey | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hootenanny | Bally | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Horrorburg | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Horseshoe | A.B.T. | 1931 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hot Chicken | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hot Line | Williams | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hot Shot | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hot Wheels | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Houdini | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Humpty Dumpty | Gottlieb | 1947 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hunter | Jennings | 1935 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Hustler | LTD do Brasil | 1980 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| I Dream of Jeannie | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| I.G.F. Interstellar Ground Force | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ice Age - A Mammoth Xmas Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ice Cold Beer | Taito | 1983 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Impacto | Recreativos Franco | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Impractical Jokers | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Indiana Jones | Stern | 2008 | ij4_210 | unsupported | no map in pinmame-nvram-maps |
| Indiana Jones - The Last Movie | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Indochine Central Tour | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Infectious Grooves | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Inhabiting Mars | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Inspector Gadget | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Inuyasha | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Invader | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Invasion U.S.A. Chuck Norris Tribute | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ipanema | LTD do Brasil | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Iron Balls | Unidesa | 1987 | ironball | unsupported | no map in pinmame-nvram-maps |
| Iron Maiden | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Iron Maiden | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Iron Maiden Legacy of the Beast | Stern | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Iron Maiden Senjutsu | Original | 2021 | frpwr_b7 | unsupported | no map in pinmame-nvram-maps |
| Iron Mike Tyson | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| It Pinball Madness | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| J6 Insurrection | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jack in the Box | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jack Sparrow | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jackpot | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jacks Open | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jake Mate | Recel | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jalisco | Recreativos Franco | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jalopy | Williams | 1951 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jaws | Original | 2013 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jaws | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jayce and the Wheeled Warriors | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jeepers Creepers | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jeff Wayne's Musical Version of War Of The Worlds | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jet Set Radio Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jet Spin | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jets | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jimi Hendrix | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jive Time | Williams | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Joe Bar Team | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Joe Bonamassa | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Joe Satriani | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| John Rambo | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| John Wick - BABA YAGA Pinball Edition | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| John Wick Legend | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Johnny Cash | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Johnny Cash Pinball | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Johnny Hallyday | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Joker | Gottlieb | 1950 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Joker Poker (EM) | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Joker Wild | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jolly Park | Spinball S.A.L. | 1996 | jolypark | unsupported | no map in pinmame-nvram-maps |
| Jolly Park Oktoberfest | Original | 2024 | jolypark | unsupported | no map in pinmame-nvram-maps |
| Jolly Roger | Williams | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Joust | Bally | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Captain Fantastic | Bally | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Deadpool | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Foo Fighters | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Friday the 13th | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Ghostbusters Slimer | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Grand Prix | Stern | 2005 | dalejr.zip, nascar.zip, gprix.zip | unsupported | no map in pinmame-nvram-maps |
| JP's Indiana Jones | Stern | 2008 | ij4_210 | unsupported | no map in pinmame-nvram-maps |
| JP's Iron Man 2 - Armored Adventures | Original | 2018 | im_183ve | unsupported | no map in pinmame-nvram-maps |
| JP's Mephisto | Cirsa | 1987 | mephisto | unsupported | no map in pinmame-nvram-maps |
| JP's Motor Show | Original | 2017 | motrshow | unsupported | no map in pinmame-nvram-maps |
| JP's Papa Smurf | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Pokemon Pinball | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Smurfette | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Space Cadet | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Street Fighter II | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's The Avengers | Original | 2019 | avs_170h | unsupported | no map in pinmame-nvram-maps |
| JP's VPX Arcade Physics | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Whoa Nellie! Big Juicy Melons | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's World Joker Tour | Original | 2024 | wpt_140a | unsupported | no map in pinmame-nvram-maps |
| JP's WOW Monopoly | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| JP's Wrath of Olympus | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jubilee | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Juke Box | Chicago Coin | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jukebox | Seeburg | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jumanji | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jumping Jack | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jungle | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jungle King | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jungle Life | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jungle Princess | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jungle Queen | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jungle Quest | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Junior | Genco | 1937 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Junkyard Cats | Original | 2012 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jurassic Park | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Jurassic Park 30th Anniversary | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Justin Timberlake | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| K-POP Demon Hunters | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| K.C. Jones | Gottlieb | 1949 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kessel Run | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kick Off | Bally | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kickboxer | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kickoff | Williams | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kidnap | CIC Play | 1986 | kidnap | unsupported | no map in pinmame-nvram-maps |
| Kill Bill | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Killer Instinct | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Killers Hall of Fame | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Killswitch Engine | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kim Wilde | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kim Wilde | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King Donkey Kong | Original | 2023 | kiko_a10 | unsupported | no map in pinmame-nvram-maps |
| King Kong | LTD do Brasil | 1978 | kkongltd | unsupported | no map in pinmame-nvram-maps |
| King Kong | Data East | 1990 | kiko_a10 | unsupported | no map in pinmame-nvram-maps |
| King Kool | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King of Diamonds | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King of Rock and Roll | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King Of The Hill | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King Pin | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King Pin | Williams | 1962 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King Rock | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King Tut | Bally | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| King Tut | Williams | 1979 | kingt_l1 | unsupported | no map in pinmame-nvram-maps |
| Kingdom | J. Esteban | 1980 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kingdom Planets | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kings & Queens | Gottlieb | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| KISS | Stern | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Klondike | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Knight Rider | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Knock Out | Gottlieb | 1950 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kratos - God of War | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kung Fu | LTD do Brasil | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kung Fu Hustle | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kusogrande | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Kyrie | Original | 2025 | walkyria | unsupported | no map in pinmame-nvram-maps |
| L'Hexagone | Christian Automatic | 1986 | hexahone | unsupported | no map in pinmame-nvram-maps |
| La Retata | Geiger | 1992 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lady Death | Geiger | 1983 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lady Luck | Recel | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lady Luck | Bally | 1986 | ladyluck | unsupported | no map in pinmame-nvram-maps |
| Lady Sharpshooter | Game Plan | 1985 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lagerstein | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lap by Lap | Inder | 1986 | lapbylap | unsupported | no map in pinmame-nvram-maps |
| Lariat | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Last Lap | Playmatic | 1978 | lastlap | unsupported | no map in pinmame-nvram-maps |
| Lawman | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lazer Lord | Stern | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| League Champ | Williams | 1996 | lc_11 | unsupported | no map in pinmame-nvram-maps |
| League of Legends Pinball | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Led Zeppelin | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Led Zeppelin | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Legend - A Pinball Adventure | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Legends of Valhalla | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Legends of Wrestlemania (Limited Edition) | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| LEGO Pinball | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Les Insus | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Les Minions | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Liberty Bell | Williams | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Life Is But a Dream - Avenged Sevenfold | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lightning Ball | Gottlieb | 1959 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Line Drive | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Linkin Park | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Linkin Park | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Little Chief | Williams | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Little Joe | Bally | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Loch Ness Monster | Game Plan | 1985 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Locomotion | Zaccaria | 1981 | locomotn | unsupported | no map in pinmame-nvram-maps |
| Logan's Run | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lone Wolf McQuade | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Looney Tunes | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Loony Labyrinth | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lortium | Juegos Populares | 1987 | lortium | unsupported | no map in pinmame-nvram-maps |
| Louis de Funes - Fantomas | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Love Bug | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Luck Smile | Inder | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lucky Ace | Williams | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lucky Hand | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lucky Luke | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lucky Strike | Taito do Brasil | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Lucky Strike | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mac Jungle | MAC | 1987 | mcjungle | unsupported | no map in pinmame-nvram-maps |
| Mac's Galaxy | MAC | 1986 | macgalaxy, nacgalxy | unsupported | no map in pinmame-nvram-maps |
| Mach 2.0 Two | Spinball S.A.L. | 1995 | mach2 | unsupported | no map in pinmame-nvram-maps |
| Mad Race | Playmatic | 1985 | madrace | unsupported | no map in pinmame-nvram-maps |
| Mad Scientist | Maxis | 1996 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Magic Circle | Bally | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Magic City | Williams | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Magic Clock | Williams | 1960 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Magic Pinball | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Magic Town | Williams | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Magnotron | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mago de Oz | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Major League | PAMCO | 1934 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Major Payne | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Majorettes | Gottlieb | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mandrake | Original | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Manowar | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Marble Queen | Gottlieb | 1953 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Marilyn Manson | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mariner | Bally | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mario Kart Pinball | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Maroon 5 | Original | 2021 | ewf | unsupported | no map in pinmame-nvram-maps |
| Married with Children | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mars Trek | Sonic | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Marsupilami | Original | 2022 | skatebrd | unsupported | no map in pinmame-nvram-maps |
| Martian Queen | LTD do Brasil | 1981 | marqueen | unsupported | no map in pinmame-nvram-maps |
| Masquerade | Gottlieb | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mass Effect | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Masters of the Universe | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Masters of the Universe | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Medieval Castle | Original | 2006 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Meducks | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Megadeth | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Melody | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Men in Black Trilogy | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mermaid | Gottlieb | 1951 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Merry-Go-Round | Gottlieb | 1960 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Metal Man | Inder | 1992 | metalman | unsupported | no map in pinmame-nvram-maps |
| Metal Slug | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Metropolis | Maresa | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Metropolis Reborn | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mets | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| MF Doom | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mibs | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Michael | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Michael Jackson | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mickey Mouse Happy Christmas | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mickey Mouse in Steamboat Willie | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Midget Hi-Ball | Peo | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Midnight Magic | Atari | 1986 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mighty Morphin Power Rangers | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mike Vegas | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mike's Pinball - 10th Anniversary Edition | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mini Cycle | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mini Golf | Williams | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mini Pool | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mini-Baseball | Chicago Coin | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Minions | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Miraculous | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Misfits | Original | 2019 | frpwr_c7 | unsupported | no map in pinmame-nvram-maps |
| Miss World | Geiger | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Miss-O | Williams | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mission Impossible | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mississippi | Recreativos Franco | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mobile Suit Gundam | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Moebius - A Tribute | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Monaco | Segasa | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Monsters | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Monsters of Rock | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Monte Carlo | Bally | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Moon Light | Inder | 1987 | moonlght | unsupported | no map in pinmame-nvram-maps |
| Moon Shot | Chicago Coin | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Moon Station | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mortal Kombat | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mortal Kombat II | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Motley Crue | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Motley Crue - Carnival of Sin | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Motordome | Bally | 1986 | motrdome | unsupported | no map in pinmame-nvram-maps |
| Moulin Rouge | Williams | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mr. & Mrs. Pec-Men | LTD do Brasil | 1983 | pecmen | unsupported | no map in pinmame-nvram-maps |
| Mr. Big | Original | 2025 | sorc_l1 | unsupported | no map in pinmame-nvram-maps |
| Mr. Bubble | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mr. Doom | Recel | 1979 | r_mrdoom | unsupported | no map in pinmame-nvram-maps |
| Mr. Evil | Recel | 1978 | r_mrevil | unsupported | no map in pinmame-nvram-maps |
| Mundial 90 | Inder | 1990 | mundial | unsupported | no map in pinmame-nvram-maps |
| Muppets | Original | 2022 | nautilus | unsupported | no map in pinmame-nvram-maps |
| Mushroom Madness | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mustang | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Mustang (Limited Edition) | Stern | 2014 | mt_145h | unsupported | no map in pinmame-nvram-maps |
| Mystical Ninja Goemon | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nagatoro | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nags | Williams | 1960 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nairobi | Maresa | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Naruto Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nautilus | Playmatic | 1984 | nautilus | unsupported | no map in pinmame-nvram-maps |
| NBA Chicago Bulls | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| NBA Mac | MAC | 1986 | nbamac | unsupported | no map in pinmame-nvram-maps |
| Nebulon | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nebulon 2 - Humanity's Stand | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nebulon 3 - The Final Boss | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Need for Speed | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nemesis | Peyper | 1986 | nemesis | unsupported | no map in pinmame-nvram-maps |
| Neptune | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nevermind The Bollocks | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| New World | Playmatic | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| New York | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nickelback | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Night of the Living Dead | Pinventions | 2014 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Night of the Living Dead '68 | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nightmare | Digital Illusions | 1992 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nightmare Before Christmas | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nine Inch Nails | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ninja Gaiden | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nip-It | Bally | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nirvana | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| NOBS | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| North Pole | Playmatic | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| North Star | Gottlieb | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nosferatu 1922 | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nova Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Now | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nudge Test and Calibration | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nudge-It | Gottlieb | 1990 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nudgy | Bally | 1947 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nuka Cola - Pop-A-Top Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Nuke Em High | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| O Brother, Where Art Thou | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| O Gaucho | LTD do Brasil | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Octopus | Nintendo | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Odds & Evens - Bud Spencer & Terence Hill | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Odin Deluxe | Sonic | 1985 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Odisea Paris-Dakar | Peyper | 1987 | odisea | unsupported | no map in pinmame-nvram-maps |
| Off Road Racers | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ol' Ireland | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Old Chicago | Bally | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Old Coney Island! | Game Plan | 1979 | coneyis | unsupported | no map in pinmame-nvram-maps |
| Old Tunes | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Olympics | Gottlieb | 1962 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Olympics | Chicago Coin | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Olympus | Juegos Populares | 1986 | olympus | unsupported | no map in pinmame-nvram-maps |
| On Beam | Bally | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| One Piece | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| One Punch Man Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Op-Pop-Pop | Bally | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Operation Highjump | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Orbit | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Out of Sight | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Outer Space | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| OXO | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| PacMan | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Paddock | Williams | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pain | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Palace Guard | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Paolo NUTINI | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Paradise | Gottlieb | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Party Animal | Bally | 1987 | prtyanim | unsupported | no map in pinmame-nvram-maps |
| Pass The Flame - Lunar Howl 12 | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pat Hand | Williams | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Paul Bunyan | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| PDC Darts 2023 | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| PDC World Darts | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pennant Fever | Williams | 1984 | pfevr_p3 | unsupported | no map in pinmame-nvram-maps |
| Penthouse | Pinball Dreams | 2008 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Peppa Pig Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Persona 5 Demo | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Petaco | Juegos Populares | 1984 | petaco | unsupported | no map in pinmame-nvram-maps |
| Petaco 2 | Juegos Populares | 1985 | petaco2 | unsupported | no map in pinmame-nvram-maps |
| Phantasm | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Phantogram | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Phantom Haus | Williams | 1996 | ph_04 | unsupported | no map in pinmame-nvram-maps |
| Phantom of the Paradise | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pharaoh - Dead Rise | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Phase II | J. Esteban | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Phil Collins | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Phish | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pierce The Veil | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Piggy Bank Blitz | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pin City | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pin-Up | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pinball Action | Tekhan | 1985 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pinball Domes | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pinball Lizard | Game Plan | 1980 | lizard | unsupported | no map in pinmame-nvram-maps |
| Pinball Magic | Capcom | 1995 | pmv112 | unsupported | no map in pinmame-nvram-maps |
| Pinball Solitaire | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pinball Squared | Gottlieb | 1984 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pinball Squared | Gottlieb | 1984 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| PinBlob | Original | 2024 | atlantis | unsupported | no map in pinmame-nvram-maps |
| Pindar - The Lizard King | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pink Bubble Monsters | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pink Floyd - The Wall | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pink Wind Turbine | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pinocchio | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| PinUP JukeBox - The 80s | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pioneer | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pipeline | Gottlieb | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pirate Gold | Chicago Coin | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pirates Life - The Revenge of Cecil Hoggleston | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pirates of the Caribbean | Stern | 2006 | potc_600as | unsupported | no map in pinmame-nvram-maps |
| Pistol Poker | Alvin G. | 1993 | pstlpkr1 | unsupported | no map in pinmame-nvram-maps |
| Pit Stop | Williams | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pizza Time | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| PJ Masks | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Planet Hemp | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Planet of the Apes | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Planets | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Play Ball | Gremlin | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Play Pool | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Playball | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Playmate | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| PlayMates | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pokemon Mystery Dungeon | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pokemon Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pokemon Slots | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pole Position | Sonic | 1987 | poleposn | unsupported | no map in pinmame-nvram-maps |
| Police Academy | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Polo | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Polo Skill | A. Pirmischer | 1931 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Poltergeist | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pompeii | Williams | 1978 | pomp_l1 | unsupported | no map in pinmame-nvram-maps |
| Pop-A-Card | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Poseidon | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Positronic | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Post Time | Williams | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Primordial Quarry | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Primus | Stern | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Prison Break | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pro Pinball The Web | Cunning Developments | 1995 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pro Pool | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pro-Football | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Professional Pinball - Challenger I | Professional Pinball | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Professional Pinball - Challenger V | Professional Pinball | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Prospector | Sonic | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pseudo Echo | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Psychedelic | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| PT01 | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pulp Fiction | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pulp Fiction | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Punch-Out | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Punchy the Clown | Alvin G. | 1993 | punchy | unsupported | no map in pinmame-nvram-maps |
| Punchy The Cow | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Punk Park | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Puscifer Pinball | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Putin Vodka Mania | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Pyramid | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Queen | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Queen - The Game | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Queen - The Show Must Go On | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Queen of Hearts | Gottlieb | 1952 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Queens of the Stone Age | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Quick Draw | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Quijote | Juegos Populares | 1987 | pimbal, r_quijote | unsupported | no map in pinmame-nvram-maps |
| R.E.M | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| R2D2 | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rack-A-Ball | Gottlieb | 1962 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Radiohead | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rails | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rainbow | Gottlieb | 1956 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Raiponce | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rambo First Blood Part II | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ramones | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rancho | Gottlieb | 1966 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rancho | Williams | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rat Fink | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rattlecan | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rawhide | Stern | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Raygun Runner | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Re-Animator | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ready Player One | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Real | Game Plan | 1978 | real | unsupported | no map in pinmame-nvram-maps |
| Red Baron | Chicago Coin | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Red Electric Rhapsody | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Red Hot Chili Peppers | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Red Hot Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ren & Stimpy Space Madness | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Resident Alien | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Resident Evil | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Retro King | Original | 2004 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Retro Zombie Adventure Land | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Return of the Living Dead | Original | 2021 | faeton | unsupported | no map in pinmame-nvram-maps |
| Rey de Diamantes | Petaco | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Riccione | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rick and Morty | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rick and Morty | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rider's Surf | Jocmatic | 1986 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rise Against | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Riviera | Chicago Coin | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ro Go | Bally | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Road Blues | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Road Race | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Road Runner | Atari | 1979 | roadrunr | unsupported | no map in pinmame-nvram-maps |
| Road Train | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rob Zombie's Spookshow International | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Robocop 3 | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Robotech: The Macross Saga | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Robots Invasion | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rock 2500 | Playmatic | 1985 | rock2500 | unsupported | no map in pinmame-nvram-maps |
| Rock and Roll | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rock in Rio | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rock Music | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rock N Roll Diner | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rock Star | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rock Sugar | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rockabilly | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rocket III | Bally | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| RockMakers | Bally | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rocky | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rocky Balboa | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rocky Legends | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rocky TKO | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rocky vs. Balutito | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rod Stewart | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Roller Coaster | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Roller Derby | Bally | 1960 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rollet | Barok Co | 1931 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Roman Victory | Taito do Brasil | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Route 66 | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Roy Clark The Entertainer | Allied Leisure | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Roy Orbison | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Royal Blood | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Royal Flush | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Royal Guard | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Royal Pair | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Running Horse | Inder | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rush 2112 | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Rush LE Tribute | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ryoko | Original | 2003 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Safe Australia | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Saint Seiya - I Cavalieri dello zodiaco | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Saloon | Taito do Brasil | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Salsa | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Samba | LTD do Brasil | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| San Francisco | Williams | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| San Ku Kai | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sands of the Aton | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sapporo | Sega | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Satin Doll | Williams | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Saucer Secrets | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Saving Wallden | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Saw - The Final Game | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Saxon | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Scarface - Balls and Power | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Schuss | Rally | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Scooby-Doo! | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Scott Pilgrim vs. the World | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Scram! | Hutchison | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Scramble | Tecnoplay | 1987 | scram_tp | unsupported | no map in pinmame-nvram-maps |
| Scream | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Scrooged | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Scuba | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sea Jockeys | Williams | 1951 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sea Ray | Bally | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Secret Agent | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| See Saw | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Seinfeld | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Senna - Prototype Edition | Culik Pinball | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sepultura | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Serious Sam II | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Serious Sam Pinball | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sesame Street | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Seven Winner | Inder | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Shamrock | Inder | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Shangri-La | Williams | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Shark | Hankin | 1980 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sharp Shooter II | Game Plan | 1983 | sshootr2 | unsupported | no map in pinmame-nvram-maps |
| Sharpshooter | Game Plan | 1979 | sshooter | unsupported | no map in pinmame-nvram-maps |
| Sharpshooter | Bally | 1961 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sheriff | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sherokee | Rowamet | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ship Ahoy | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ship-Mates | Gottlieb | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Shooting Star (Junior) | Daval | 1934 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Shooting The Rapids Deluxe | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Short Circuit | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Shovel Knight | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Show Boat | Gottlieb | 1961 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Shrek | Stern | 2008 | shr_141 | unsupported | no map in pinmame-nvram-maps |
| Shrek the Halls | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Shuffle Inn | Williams | 1989 | shfin_l1 | unsupported | no map in pinmame-nvram-maps |
| Silent Night Deadly Night | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Silver Cup | Genco | 1933 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Silver Line | Bill Port | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sing Along | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sir Lancelot | Peyper | 1994 | lancelot | unsupported | no map in pinmame-nvram-maps |
| Sittin' Pretty | Gottlieb | 1958 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Skate and Destroy | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Skateboard | Inder | 1980 | skatebrd | unsupported | no map in pinmame-nvram-maps |
| Skipper | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Skittles | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sky Jump | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sky Kings | Bally | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sky Ride | Genco | 1933 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sky-Line | Gottlieb | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Skylab | Williams | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Skyrocket | Bally | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Skyscraper | Bally | 1934 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Skyway | Williams | 1954 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Slayer | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sleic Pin-BALL | Sleic | 1994 | sleicpnf | unsupported | no map in pinmame-nvram-maps |
| Slick Chick | Gottlieb | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Slipknot | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| SlugFest | Williams | 1991 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Smart Set | Williams | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Smokey and the Bandit | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Smooth Hot Ride 3 - From Natchez to Mike Vegas | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Snake DMD | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Snooker | Gottlieb | 1985 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Snow Derby | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Snow Queen | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Soccer | Williams | 1964 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Soccer | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Solar City | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Solar Ride | Rowamet | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Solar Ride | Electromatic | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Solar Sailor | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Solar Wars | Sonic | 1986 | solarwar | unsupported | no map in pinmame-nvram-maps |
| Solids N Stripes | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Solitaire | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sonic The Hedgehog | Original | 2005 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sonic the Hedgehog 2 | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sonic the Hedgehog Spinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sons of Anarchy | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sound Stage | Chicago Coin | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| South Park Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| South Park Xmas Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Soylent Green | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Cadet | Microsoft | 1995 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Gambler | Playmatic | 1978 | spcgambl.zip | unsupported | no map in pinmame-nvram-maps |
| Space Mission | Williams | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Odyssey | Williams | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Orbit | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Patrol | Taito do Brasil | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Platform - Murray Leinster | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Poker | LTD do Brasil | 1982 | spcpoker | unsupported | no map in pinmame-nvram-maps |
| Space Race | Recel | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Rider | Geiger | 1980 | hglbtrtb.zip, hglbtrtr.zip | unsupported | no map in pinmame-nvram-maps |
| Space Romance | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Sheriff Gavan (X-Or) | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Ship | Unidesa | 1986 | spcship | unsupported | no map in pinmame-nvram-maps |
| Space Time | Bally | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Train | MAC | 1987 | spctrain | unsupported | no map in pinmame-nvram-maps |
| Space Tug - Murray Leinster | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Space Walk | Gottlieb | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| SpaceRamp | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spanish Eyes | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spark Plugs | Williams | 1951 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spawn | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Speakeasy | Playmatic | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Special Force | Bally | 1986 | specforc | unsupported | no map in pinmame-nvram-maps |
| Species | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Speed Racer | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spider-Man | Stern | 2007 | sman_261 | unsupported | no map in pinmame-nvram-maps |
| Spider-Man (Black Suited) | Stern | 2007 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spin Out | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spin Wheel | Gottlieb | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spin-A-Card | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spinning Wheel | Automaticos | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spirit of 76 | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Splatter Blast Studio | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Splatterhouse | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| SpongeBob Squarepants Pinball Adventure | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| SpongeBob's Bikini Bottom Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spooky Wednesday | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spot a Card | Gottlieb | 1960 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Spot Pool | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Squid Game | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Stabby The Unicorn | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Stampede | Stern | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Action | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Fire | Playmatic | 1985 | starfire | unsupported | no map in pinmame-nvram-maps |
| STAR FOX – BATTLE FOR LYLAT | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Knights | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Mission | Durham | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Pool | Williams | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Ship | Bally | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Trek | Gottlieb | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Trek - Voyager - Seven of Nine (Borg Edition) | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Trip | Game Plan | 1979 | startrip | unsupported | no map in pinmame-nvram-maps |
| Star Wars | Sonic | 1987 | sonstwar | unsupported | no map in pinmame-nvram-maps |
| Star Wars | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Wars | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Wars - Bounty Hunter | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star Wars - Episode I | Original | 2023 | empsback | unsupported | no map in pinmame-nvram-maps |
| Star Wars - The Bad Batch | Original | 2022 | gamatron | unsupported | no map in pinmame-nvram-maps |
| Star Wars - The Empire Strikes Back | Hankin | 1980 | empsback | unsupported | no map in pinmame-nvram-maps |
| Star Wars Redux | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Star-Jet | Bally | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Stardust | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Steel Panther 1987 | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Stellar Airship | Geiger | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Steve Miller Band | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Stick Figure | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Still Crazy | Williams | 1984 | scrzy_l1 | unsupported | no map in pinmame-nvram-maps |
| Stock Car | Gottlieb | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Straight Flush | Williams | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Strange Science | Bally | 1986 | strngsci | unsupported | no map in pinmame-nvram-maps |
| Strange World | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Stranger Things | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Stranger Things - Stranger Edition | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Strato-Flite | Williams | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Streets of Rage | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Strike | Zaccaria | 1978 | strike.zip | unsupported | no map in pinmame-nvram-maps |
| Strike Master | Williams | 1991 | strik_l4 | unsupported | no map in pinmame-nvram-maps |
| Strike Zone | Williams | 1984 | szone_l5 | unsupported | no map in pinmame-nvram-maps |
| Strikes N' Spares | Gottlieb | 1995 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Strip Joker Poker | Gottlieb | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Stripping Funny | Inder | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Student Prince | Williams | 1968 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Summer Time | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sunset Riders Pinball | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Super Mario Galaxy Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Super Nova | Game Plan | 1980 | suprnova | unsupported | no map in pinmame-nvram-maps |
| Super Score | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Super Soccer | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Super Spin | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Super Star | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Super Star | Chicago Coin | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Super Straight | Sonic | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Super-Flite | Williams | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Superman - The Animated Series | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Superman and The Justice League | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Supreme Dance Mix | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sure Shot | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Surf Champ | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Surf Side | Gottlieb | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Surfer | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Svengoolie | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Swamp Thing | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Swashbuckler | Recel | 1979 | r_swash | unsupported | no map in pinmame-nvram-maps |
| Sweet Hearts | Gottlieb | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sweet Sioux | Gottlieb | 1959 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Swing-Along | Gottlieb | 1963 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Swinger | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Sword Dancer | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Symphony IX - The Machine of Joy | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| T and C Surf | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| T-Rex | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| T.K.O. | Gottlieb | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Table Starter | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Take Five | Allied Leisure | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Talk Talk | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Talking Word Clock | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tam-Tam | Playmatic | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Target Alpha | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Target Pool | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Target Practice | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tarzan - Lex Barker Tribute Edition | Original | 2023 | wolfman | unsupported | no map in pinmame-nvram-maps |
| Tasty Samba | Inder | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Taylor Swift Eras Tour Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Teacher's Pet | Williams | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Team America World Police | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Team One | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Teenage Mutant Ninja Turtles (Stern / Data East remix) | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Teenage Mutant Ninja Turtles Remix | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tempest - Lunar Howl 10 | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ten Stars | Zaccaria | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ten Strike Classic | Benchmark Games | 2003 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Terminator Salvation | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Terrific Lake | Sport matic | 1987 | terrlake | unsupported | no map in pinmame-nvram-maps |
| Terrifier | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Test Pilots | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Texas Poker | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Texas Ranger | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The 12 Days of Christmas | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The A-Team | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Adventures of TinTin | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Amazing Dr. Nim | E.S.R. Inc | 1965 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Avengers - TV Series | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Batman | Original | 2022 | bdk_240 | unsupported | no map in pinmame-nvram-maps |
| The Big Lebowski Pinball | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Blizzard Of Ozz | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Blues Brothers | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Blues Brothers 40th Anniversary | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Bourne Identity | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Brady Bunch | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Cerebral Maze | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Clash | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Clash Pro - Audio Ammunition | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Collected Tragedies of Metal Man and The Mongoose | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Conjuring | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Crow | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Cure | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Dark Crystal Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Doors | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Electric State OG | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Endless Summer | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Exorcist | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Fantastic Four | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Fifth Element | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Flash - Comic Verison | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Fog | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Forgotten Planet - Murray Leinster | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Games | Gottlieb | 1984 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Games I | Gottlieb | 1983 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Games I | Gottlieb | 1983 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Gaston Pinball Machine | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Godfather | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Goonies Never Say Die Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Goonies Pinball Adventure | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Great Giana Sisters | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Grinch | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Grinch Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Hateful Eight | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Incredible Hulk | Gottlieb | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Insus | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Lab | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Last Dragon | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Last Dragon | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Last Ninja | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Last of Us | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Last Spaceship - Murray Leinster | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Last Starfighter | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Last Unicorn | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Legend of Zelda | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Legend Of Zelda Twilight Princess | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Leprechaun King | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Lost Boys | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Lost World Jurassic Park | Sega | 1997 | 2.02, 2.00 | unsupported | no map in pinmame-nvram-maps |
| The Magnificent Seven | Original | 2020 | coneyis | unsupported | no map in pinmame-nvram-maps |
| The Mandalorian | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Maple Leaf | Automatic | 1932 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Mask | Original | 2019 | lortium | unsupported | no map in pinmame-nvram-maps |
| The Matrix | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Matrix | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Moon Walking Dead | Original | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Munsters | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Munsters | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The NeverEnding Story | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Nightmare Before Christmas | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Office | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Pabst Can Crusher | Stern | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Paw Patrol | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Pinball Food Fight | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Polar Express | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Police | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Price is Right - 2 For the Price of 1 | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Price is Right - 50 Year | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Price is Right - Five Price Tags | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Price is Right - Grand Game 2.0 | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Price Is Right - Original | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Price is Right - Plinko | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Princess Bride | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Prodigy | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Purge | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Raid | Playmatic | 1984 | theraid | unsupported | no map in pinmame-nvram-maps |
| The Return of the Living Dead | Original | 2020 | darkshad | unsupported | no map in pinmame-nvram-maps |
| The Rolling Stones | Stern | 2011 | rsn_110h | unsupported | no map in pinmame-nvram-maps |
| The Shining | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Simpsons Christmas | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Simpsons Kooky Carnival | Stern | 2006 | scarn200 | unsupported | no map in pinmame-nvram-maps |
| The Snowman | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Spellcast Machine | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Sword of Fury | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Table With The Least Comprehensible Theme Ever | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Terminator | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Terminator | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Texas Chainsaw Massacre | Original | 2020 | nautilus | unsupported | no map in pinmame-nvram-maps |
| The Wailing Asteroid - Murray Leinster | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Walking Dead | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Walking Dead (Pro) | Stern | 2014 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Wiggler | Bally | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Wild Wild West | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Wizard | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The Woodcutter | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| The X Files | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Theatre of Houdini | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| They Live | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Thornley | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Three Angels | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Thunder Man | Apple Time | 1987 | pinchamp.zip, thndrman.zip | unsupported | no map in pinmame-nvram-maps |
| Thunderbirds | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Thunderbirds 60th Anniversary | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Thundercats Pinball | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ticket Tac Toe | Williams | 1996 | ttt_10 | unsupported | no map in pinmame-nvram-maps |
| Tidal Wave | Gottlieb | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tidal Wave | Gottlieb | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tiger | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tiki Bob's Atomic Beach Party | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tiki Bob's Swingin' Holiday Soiree | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tiki Time | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| TikiSurfPunch | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Time Lord | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Time Machine | LTD do Brasil | 1984 | tmacltd4 | unsupported | no map in pinmame-nvram-maps |
| Time Traveler | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Time Tunnel | Bally | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Timon & Pumbaa's Jungle Pinball | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tiro's | Maresa | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Titan | Gottlieb | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Titan | Gottlieb | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| TMNT | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Toledo | Williams | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tom & Jerry | Original | 2018 | tomjerry | unsupported | no map in pinmame-nvram-maps |
| Tom Petty | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tomb Raider | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tomb Raider - A Survival is Born | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tommy Boy | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tool | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Top Card | Gottlieb | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Top Dawg | Williams | 1988 | tdawg_l1 | unsupported | no map in pinmame-nvram-maps |
| Top Hand | Gottlieb | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Top of the Pops Xmas Pinball | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Top Score | Gottlieb | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Topaz | Inder | 1979 | tpazi | unsupported | no map in pinmame-nvram-maps |
| Tornado Rally | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Torpedo!! | Petaco | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Total Nuclear Annihilation | Spooky Pinball | 2017 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Touchdown | Williams | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Toy Story 90s Pinball | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Trade Winds | Williams | 1962 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Trail Drive | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Trailer | Playmatic | 1985 | trailer | unsupported | no map in pinmame-nvram-maps |
| Trailer Park Boys - Pin-Ballers | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tramway | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Transformers G1 | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Travel Time | Williams | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Treff | Walter Steiner | 1949 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Trials of Kaladon | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Trick 'r Treat | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Trick Shooter | LTD do Brasil | 1980 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Triple Action | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Triple Strike | Williams | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Triple X | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| TRON Neon | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tropic Fun | Williams | 1973 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tropic Isle | Gottlieb | 1962 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Truck Stop | Bally | 1988 | trucksp3 | unsupported | no map in pinmame-nvram-maps |
| Turrican | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Twin Peaks | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Twinky | Chicago Coin | 1967 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Twisted Metal | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tyrannosaurus | Gottlieb | 1985 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Tyrannosaurus | Gottlieb | 1985 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| U-Boat 65 | Nuova Bell Games | 1988 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| U-FOES | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| U2 | Original | 2024 | stringray | unsupported | no map in pinmame-nvram-maps |
| UB40 | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ultron | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Ulysse 31 | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Uncomposed Arrangement - Lunar Howl 9 | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Underwater | Recel | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Unicorcs | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Universe | Gottlieb | 1959 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Universe | Zaccaria | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Unreal Tournament 99 Capture the Flag | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| V.1 | IDSA | 1986 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Valencia | Williams | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Vampire | Bally | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Van Halen | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Vasco da Gama | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Vector Pinball (Field One) | Dozing Cat Software | 2010 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Vegas | Game Plan | 1979 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| VeggieTales | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Verne's World | Spinball S.A.L. | 1996 | vrnwrld | unsupported | no map in pinmame-nvram-maps |
| Viking King | LTD do Brasil | 1979 | vikngkng | unsupported | no map in pinmame-nvram-maps |
| Vikings | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Volkan Steel and Metal | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Volley | Gottlieb | 1976 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Voodoo Ranger | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| VooDoo's Carnival Pinball | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Vortex Plunder | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| VPin Workshop Example & Resource Table | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| VPX Foosball 2019 | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| VR Clean Room with Tutorial | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| VR Room Educational Toyboy | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Vulcan | Gottlieb | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Vulcan IV | Rowamet | 1982 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wacky Races | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wade Wilson | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Walkure | Original | 2025 | walkyria | unsupported | no map in pinmame-nvram-maps |
| Walkyria | Joctronic | 1986 | walkyria | unsupported | no map in pinmame-nvram-maps |
| Wallace And Gromit | Original | 2006 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Warrior Sea | Electromatic | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Watchmen | Original | 2019 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wheel | Maresa | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wheel of Fortune | Stern | 2007 | wof_500 | unsupported | no map in pinmame-nvram-maps |
| Whirl-Wind | Gottlieb | 1958 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| White Christmas | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Whitesnake | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Whoa Nellie! Big Juicy Melons | WhizBang Pinball | 2011 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Whoa Nellie! Big Juicy Melons | Stern | 2015 | wn-1_55_0.spk | unsupported | no map in pinmame-nvram-maps |
| Wild Card | Williams | 1977 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wild Life | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wild West | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wild Wild West | Gottlieb | 1969 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Willow | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Willy Wonka & the Chocolate Factory | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Willy's Wonderland | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wimbledon | Electromatic | 1978 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Winner | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wizard! | Bally | 1975 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wolf Man | Peyper | 1987 | wolfman | unsupported | no map in pinmame-nvram-maps |
| Wolfenstein 3D | Original | 2015 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wonderland | Williams | 1955 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Woody Woodpecker | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| World Poker Tour | Stern | 2006 | wpt_140a | unsupported | no map in pinmame-nvram-maps |
| World Series | Gottlieb | 1972 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| World's Fair Jig-Saw | Rock-ola | 1933 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| WoZ | Original | 2018 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Wuthering Waves | Original | 2026 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Yale | Inder | 1974 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Yamanobori | Komaya | 1981 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Yellow Submarine | Original | 2020 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Yes | Original | 2025 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| You’ll Shoot Your Eye Out! | Original | 2024 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Young Frankenstein | Original | 2016 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Young Frankenstein | Original | 2021 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Yukon | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Yukon (Special) | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Zeke's Peak | Taito | 1984 | zeakpeak | unsupported | no map in pinmame-nvram-maps |
| Zephy | LTD do Brasil | 1982 | zephy | unsupported | no map in pinmame-nvram-maps |
| Zip-A-Doo | Bally | 1970 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Zira | Playmatic | 1980 | zira | unsupported | no map in pinmame-nvram-maps |
| Zissou - The Life Aquatic | Original | 2022 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Zodiac | Williams | 1971 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Zonderik Pinball | Belgamko | 2010 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
| Zone Fury | Original | 2023 |  | unsupported | no ROM (original table: needs recipe B–E, C1.1) |
