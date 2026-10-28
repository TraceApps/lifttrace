/**
 * The Diary's Load Workout planning as it was before issue #140 moved it
 * into lib/planned-workout.js: Diary.svelte's resolveWeek and the body of
 * loadTemplate (dev d72343c), copied as it was with the stores passed in.
 * planned-workout.test.js runs both on the same days and checks they plan
 * every one the same way, so moving it changed nothing in the Diary.
 */
import { parseDuration, generateWarmupSets } from '../../src/lib/planned-workout.js';

function resolveWeek(ex, wk) {
  const base = {
    sets: ex.target_sets, reps: ex.target_reps, weight: ex.target_weight,
    duration: ex.target_duration,
    tempo: ex.tempo, rest_sec: ex.rest_sec,
  };
  if (!wk || !ex.weeks?.length) return base;
  const w = ex.weeks[wk - 1];
  if (!w) return base;
  return {
    sets: w.sets ?? base.sets,
    reps: w.reps ?? base.reps,
    weight: w.weight ?? base.weight,
    duration: w.duration ?? base.duration,
    tempo: w.tempo ?? base.tempo,
    rest_sec: w.rest_sec ?? base.rest_sec,
  };
}

// getLastSets(exerciseId, { withWarmups: true }) as the Diary answered it:
// last session's completed sets, or null. $autoGenerateWarmups, $weightUnit.
export async function diaryLoadTemplateBefore140(template, { planWeek, getLastSets, autoGenerateWarmups, weightUnit }) {
  const templateExercises = await Promise.all((template.exercises || []).map(async ex => {
    const lastAll = await getLastSets(ex.exercise_id, { withWarmups: true });
    const lastSets = lastAll ? lastAll.filter(s => !s.warmup) : null;
    const lastWarmups = lastAll ? lastAll.filter(s => s.warmup) : [];
    const eff = resolveWeek(ex, planWeek);
    const planWins = !!(planWeek && ex.weeks?.length);
    let sets;
    if (ex.set_specs && ex.set_specs.length > 0) {
      let workIdx = 0, warmIdx = 0;
      sets = ex.set_specs.map((spec) => {
        const past = spec.warmup ? lastWarmups[warmIdx++] : lastSets?.[workIdx++];
        const parsedWeight = parseFloat(spec.weight);
        const parsedReps = parseInt(spec.reps);
        const parsedRepsL = parseInt(spec.reps_l);
        const parsedRepsR = parseInt(spec.reps_r);
        const set = {
          weight: Number.isFinite(parsedWeight) ? parsedWeight : (past?.weight ?? 0),
          reps: Number.isFinite(parsedReps) ? parsedReps : (past?.reps ?? 0),
          completed: false,
          notes: '',
        };
        if (ex.set_type === 'time') {
          const dur = parseDuration(spec.duration) ?? past?.duration_sec ?? 0;
          if (dur) set.duration_sec = dur;
        }
        if (spec.number != null) set.number = spec.number;
        if (spec.warmup) set.warmup = true;
        if (spec.rpe != null) set.rpe = spec.rpe;
        if (Number.isFinite(parsedRepsL)) set.reps_l = parsedRepsL;
        if (Number.isFinite(parsedRepsR)) set.reps_r = parsedRepsR;
        return set;
      });
    } else {
      const numSets = eff.sets || 1;
      const tplWeight = parseFloat(eff.weight);
      const tplReps = parseInt(eff.reps);
      const baseWeight = Number.isFinite(tplWeight) ? tplWeight : 0;
      const baseReps = Number.isFinite(tplReps) ? tplReps : 0;
      if (lastSets && !planWins) {
        sets = Array.from({ length: numSets }, (_, i) => ({
          weight: lastSets[i]?.weight ?? lastSets[lastSets.length - 1]?.weight ?? baseWeight,
          reps: lastSets[i]?.reps ?? lastSets[lastSets.length - 1]?.reps ?? baseReps,
          completed: false,
          notes: '',
        }));
      } else {
        sets = Array.from({ length: numSets }, () => ({
          weight: baseWeight, reps: baseReps, completed: false, notes: '',
        }));
      }
      if (ex.set_type === 'time') {
        const planned = parseDuration(eff.duration) || 0;
        sets = sets.map((set, i) => {
          const fromLast = (lastSets && !planWins)
            ? (lastSets[i]?.duration_sec ?? lastSets[lastSets.length - 1]?.duration_sec)
            : null;
          const dur = fromLast || planned;
          return dur ? { ...set, duration_sec: dur } : set;
        });
      }
    }
    return { ...ex, tempo: eff.tempo, rest_sec: eff.rest_sec, sets };
  }));

  const withWarmups = autoGenerateWarmups
    ? templateExercises.map(ex => {
        if (ex.set_type === 'time' || (ex.sets || []).some(s => Number(s.duration_sec) > 0)) return ex;
        const firstWorking = (ex.sets || []).find(s => !s.warmup);
        const w = parseFloat(firstWorking?.weight || ex.target_weight || 0) || 0;
        const warmups = generateWarmupSets(w, weightUnit);
        if (warmups.length === 0) return ex;
        return { ...ex, sets: [...warmups, ...(ex.sets || [])] };
      })
    : templateExercises;
  return withWarmups;
}
