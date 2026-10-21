#!/usr/bin/env bash
# Renders each clip through the game's own chain (manifest gain, the role's level, lowpass, rate, envelope,
# cut) with ffmpeg and measures what comes out, padded to one second so the numbers compare: RMS over the
# second (energy), the loudest 50 ms window (how hard it jumps out), the sample peak, and the spectral
# centroid (brightness, Hz). LUFS needs 400 ms of sound and a footstep is shorter, so RMS it is.
#   bash measure-sounds.sh [step_level] [levelOf_water] [cut_water] [splash_level] [swim_level] [splash_lp] [swim_lp] [splash_attack] [swim_attack]
# Defaults are the game as shipped before the water change of 2026-10-18; the chain mirrors sounds.js (STEP, WET) and must be kept in step with it.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)/prototype/sounds/candidates"
SL="${1:-0.28}"; LW="${2:-1.6}"; CW="${3:-2600}"; SPL="${4:-0.66}"; SWL="${5:-0.45}"; SPLP="${6:-0}"; SWLP="${7:-0}"; SPA="${8:-0}"; SWA="${9:-0}"
measure() { # name file chain
  local name="$1" f="$2" chain="$3"
  local log; log=$(ffmpeg -nostats -hide_banner -i "$DIR/$f" -af "$chain,apad=whole_dur=1,astats" -f null - 2>&1)
  local R; R=$(echo "$log" | grep "RMS level dB" | tail -1 | awk '{print $NF}')
  local RP; RP=$(echo "$log" | grep "RMS peak dB" | tail -1 | awk '{print $NF}')
  local P; P=$(echo "$log" | grep "Peak level dB" | tail -1 | awk '{print $NF}')
  local C; C=$(ffmpeg -nostats -hide_banner -i "$DIR/$f" -af "$chain,aspectralstats=measure=centroid,ametadata=mode=print:key=lavfi.aspectralstats.1.centroid:file=-" -f null - 2>/dev/null | grep -oE "centroid=[0-9.]+" | awk -F= '{s+=$2;n++} END{if(n)printf "%.0f", s/n; else print "?"}')
  printf "%-16s %-44s  rms/1s %6s  loudest50ms %6s  peak %6s  centroid %5s Hz\n" "$name" "$f" "$R" "$RP" "$P" "$C"
}
# the footstep chain: rate (asetrate pitches and slows like playbackRate), lowpass Q 0.7, level, 35 ms fade in, decay from 0.115 s (tau 0.08), cut at 0.34 s
stepchain() { local gain="$1" cutoff="$2" rate="$3" lvl="$4"; echo "aresample=48000,asetrate=48000*$rate,aresample=48000,lowpass=f=$cutoff:width_type=q:w=0.7,volume=$(awk "BEGIN{print $gain*$lvl}"),afade=t=in:st=0:d=0.035,afade=t=out:st=0.115:d=0.24:curve=exp,atrim=0:0.34"; }
waterchain() { local gain="$1" lvl="$2" lp="$3" attack="$4" cut="$5"; local c="aresample=48000,volume=$(awk "BEGIN{print $gain*$lvl}")"; [ "$lp" != "0" ] && c="$c,lowpass=f=$lp:width_type=q:w=0.7"; [ "$attack" != "0" ] && c="$c,afade=t=in:st=0:d=$attack"; echo "$c,atrim=0:$cut"; }
echo "step level $SL | wet step x$LW lowpass $CW | splash level $SPL lowpass $SPLP attack $SPA | swim level $SWL lowpass $SWLP attack $SWA"
echo "--- dry footsteps (walking) ---"
measure "grass" footstep-grass__footstep_grass_000.ogg "$(stepchain 3.725 850 0.8 $SL)"
measure "grass" footstep-grass__footstep_grass_003.ogg "$(stepchain 3.428 850 0.8 $SL)"
measure "dirt" footstep-dirt__footstep00.ogg "$(stepchain 1.565 750 0.8 $SL)"
measure "dirt" footstep-dirt__footstep02.ogg "$(stepchain 1.764 750 0.8 $SL)"
measure "stone" footstep-stone__footstep_concrete_001.ogg "$(stepchain 1.723 1300 0.8 $SL)"
measure "stone" footstep-stone__footstep_concrete_003.ogg "$(stepchain 1.355 1300 0.8 $SL)"
measure "wood" footstep-wood__footstep_wood_001.ogg "$(stepchain 0.989 950 0.8 $SL)"
measure "sand (dirt clip)" footstep-dirt__footstep00.ogg "$(stepchain 1.565 600 0.8 $SL)"
echo "--- water ---"
measure "wet step" footstep-water__sfx100v2_footstep_wet_02.ogg "$(stepchain 14.1 $CW 1.0 $(awk "BEGIN{print $SL*$LW}"))"
measure "wet step" footstep-water__sfx100v2_footstep_wet_03.ogg "$(stepchain 6.761 $CW 1.0 $(awk "BEGIN{print $SL*$LW}"))"
measure "splash (enter)" splash__splash_02.ogg "$(waterchain 3.388 $SPL $SPLP $SPA 0.9)"
measure "splash (enter)" splash__splash_12.ogg "$(waterchain 9.0 $SPL $SPLP $SPA 0.9)"
measure "swim stroke" swim__splash_03.ogg "$(waterchain 4.571 $SWL $SWLP $SWA 1.0)"
measure "swim stroke" swim__splash_14.ogg "$(waterchain 6.75 $SWL $SWLP $SWA 1.0)"
