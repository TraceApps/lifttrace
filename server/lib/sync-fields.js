/**
 * The fields of each table two edits of a row meet field by field
 * (lib/field-sync.js through lib/newer-wins.js): the newer edit of each
 * field stays. The server keeps when each last changed (field_times). The
 * same lists in every route that writes these tables: the app's own saves
 * (routes/workout.js, exercises.js, programs.js, templates.js), and
 * POST /api/sync/push. What merges its own way isn't here: a workout's or
 * program day's exercises and sets (one by one, by uuid,
 * lib/workout-merge.js), a day's measurements (each key on its own,
 * routes/body-stats.js), a setting (its value, one field), an excused day
 * (lib/excused-days.js).
 */
export const SYNC_FIELDS = {
  workout_log: ['name', 'notes', 'duration_min', 'completed', 'program_week', 'program_id', 'template_id'],
  exercises: [
    'name', 'category', 'primary_muscles', 'secondary_muscles', 'equipment', 'instructions', 'tips',
    'img_url', 'gif_url', 'video_url', 'load_type', 'set_type',
  ],
  programs: ['name', 'description', 'goal', 'visibility', 'duration_weeks', 'advance_mode', 'on_complete'],
  workout_templates: ['name', 'day_label'],
};

/** Fields that mean something only together, merged as one: the edit that
 *  stays brings the whole group. */
export const SYNC_GROUPS = {
  // A workout's program, the program workout it is, and the program's week.
  workout_log: [['program_id', 'template_id', 'program_week']],
  // An exercise's pictures and video.
  exercises: [['img_url', 'gif_url', 'video_url']],
  // How long a program runs and how it moves on.
  programs: [['duration_weeks', 'advance_mode', 'on_complete']],
  workout_templates: [],
};

/** Fields that hold JSON: compared by what they hold, as text or parsed. */
export const SYNC_JSON = {
  exercises: ['primary_muscles', 'secondary_muscles', 'equipment'],
};

/** The merge options for one table, as newer-wins.js takes them. */
export const syncOf = (table) => ({ fields: SYNC_FIELDS[table], groups: SYNC_GROUPS[table] || [], json: SYNC_JSON[table] || [] });
