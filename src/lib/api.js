/**
 * api.js — LiftTrace API client
 */

async function _json(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const opts = { credentials: 'include' };
const jsonOpts = { ...opts, headers: { 'Content-Type': 'application/json' } };

export const LtApi = {
  // ── Exercises ──────────────────────────────────────────────────────────
  getExercises: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetch(`/api/exercises${q ? '?' + q : ''}`, opts).then(_json);
  },
  getExercise: (id) => fetch(`/api/exercises/${id}`, opts).then(_json),
  getExerciseUsage: () => fetch('/api/exercises/usage', opts).then(_json),
  createExercise: (data) => fetch('/api/exercises', { ...jsonOpts, method: 'POST', body: JSON.stringify(data) }).then(_json),
  updateExercise: (id, data) => fetch(`/api/exercises/${id}`, { ...jsonOpts, method: 'PUT', body: JSON.stringify(data) }).then(_json),
  deleteExercise: (id) => fetch(`/api/exercises/${id}`, { ...opts, method: 'DELETE' }).then(_json),
  deleteAllCustomExercises: () => fetch('/api/exercises/custom/all', { ...opts, method: 'DELETE' }).then(_json),
  syncWger: () => fetch('/api/exercises/sync-wger', { ...opts, method: 'POST' }).then(_json),
  listExerciseMediaUrls: () => fetch('/api/exercises/media-urls', opts).then(_json),
  uploadExerciseMedia: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/upload/exercise-media', { ...opts, method: 'POST', body: fd }).then(_json);
  },
  listExerciseSources:   ()         => fetch('/api/exercises/sources/list', opts).then(_json),
  importExerciseSource:  (source, apiKey) =>
    fetch('/api/exercises/sources/import', { ...jsonOpts, method: 'POST', body: JSON.stringify({ source, apiKey }) }).then(_json),
  clearExerciseSource:   (source)   =>
    fetch('/api/exercises/sources/clear',  { ...jsonOpts, method: 'POST', body: JSON.stringify({ source }) }).then(_json),

  // ── Programs ───────────────────────────────────────────────────────────
  getPrograms: () => fetch('/api/programs', opts).then(_json),
  getProgram: (id) => fetch(`/api/programs/${id}`, opts).then(_json),
  createProgram: (data) => fetch('/api/programs', { ...jsonOpts, method: 'POST', body: JSON.stringify(data) }).then(_json),
  updateProgram: (id, data) => fetch(`/api/programs/${id}`, { ...jsonOpts, method: 'PUT', body: JSON.stringify(data) }).then(_json),
  deleteProgram: (id) => fetch(`/api/programs/${id}`, { ...opts, method: 'DELETE' }).then(_json),
  assignProgram: (id, data) => fetch(`/api/programs/${id}/assign`, { ...jsonOpts, method: 'POST', body: JSON.stringify(data) }).then(_json),
  unassignProgram: (programId, userId) => fetch(`/api/programs/${programId}/assign/${userId}`, { ...opts, method: 'DELETE' }).then(_json),
  setActiveProgram: (id) => fetch(`/api/programs/${id}/activate`, { ...opts, method: 'POST' }).then(_json),
  deactivateProgram: () => fetch('/api/programs/deactivate', { ...opts, method: 'POST' }).then(_json),
  setProgramWeekCursor: (id, week) => fetch(`/api/programs/${id}/week-cursor`, { ...jsonOpts, method: 'POST', body: JSON.stringify({ week }) }).then(_json),

  // ── Workout Templates ──────────────────────────────────────────────────
  getTemplate: (id) => fetch(`/api/templates/${id}`, opts).then(_json),
  createTemplate: (data) => fetch('/api/templates', { ...jsonOpts, method: 'POST', body: JSON.stringify(data) }).then(_json),
  updateTemplate: (id, data) => fetch(`/api/templates/${id}`, { ...jsonOpts, method: 'PUT', body: JSON.stringify(data) }).then(_json),
  deleteTemplate: (id) => fetch(`/api/templates/${id}`, { ...opts, method: 'DELETE' }).then(_json),
  reorderTemplates: (programId, ids) => fetch(`/api/programs/${programId}/reorder`, { ...jsonOpts, method: 'PUT', body: JSON.stringify({ ids }) }).then(_json),

  // ── Workout Log (diary) ────────────────────────────────────────────────
  getWorkout: (date) => fetch(`/api/workout/${date}`, opts).then(_json),
  getWorkoutFeedback: (date) => fetch(`/api/workout/${date}/feedback`, opts).then(_json),
  getCoachFeedbackInbox: () => fetch('/api/coach-feedback/inbox', opts).then(_json),
  markCoachFeedbackSeen: (id = null) => fetch('/api/coach-feedback/seen', { ...jsonOpts, method: 'POST', body: JSON.stringify(id ? { id } : {}) }).then(_json),
  getUnreadCoachFeedbackDates: () => fetch('/api/coach-feedback/unread-dates', opts).then(_json),
  replyToCoachFeedback: (id, reply) => fetch(`/api/coach-feedback/${id}/reply`, { ...jsonOpts, method: 'PUT', body: JSON.stringify({ reply }) }).then(_json),
  saveWorkout: (date, data) => fetch(`/api/workout/${date}`, { ...jsonOpts, method: 'PUT', body: JSON.stringify(data) }).then(_json),
  getRecentWorkouts: (limit = 30) => fetch(`/api/workout/recent?limit=${limit}`, opts).then(_json),
  getWorkoutHistory: (exerciseId) => fetch(`/api/workout/history/${exerciseId}`, opts).then(_json),

  // ── Body Stats ─────────────────────────────────────────────────────────
  getBodyStats: (date) => fetch(`/api/body-stats/${date}`, opts).then(_json),
  getBodyStatsRange: (start, end) => fetch(`/api/body-stats/range?start=${start}&end=${end}`, opts).then(_json),
  saveBodyStats: (date, data) => fetch(`/api/body-stats/${date}`, { ...jsonOpts, method: 'PUT', body: JSON.stringify(data) }).then(_json),

  // ── Statistics ─────────────────────────────────────────────────────────
  getVolume: (start, end) => fetch(`/api/stats/volume?start=${start}&end=${end}`, opts).then(_json),
  getFrequency: (start, end) => fetch(`/api/stats/frequency?start=${start}&end=${end}`, opts).then(_json),
  getRecords: () => fetch('/api/stats/records', opts).then(_json),
  getProgress: (exerciseId, start, end) => fetch(`/api/stats/progress/${exerciseId}?start=${start}&end=${end}`, opts).then(_json),
  getStreaks: () => fetch('/api/stats/streaks', opts).then(_json),
  getMuscleGroupVolume: (start, end) => fetch(`/api/stats/muscle-group-volume?start=${start}&end=${end}`, opts).then(_json),
  getMuscleEffectiveSets: (start, end) => fetch(`/api/stats/muscle-effective-sets?start=${start}&end=${end}`, opts).then(_json),
  getWeekdayDistribution: (start, end) => fetch(`/api/stats/weekday-distribution?start=${start}&end=${end}`, opts).then(_json),

  // ── Settings ───────────────────────────────────────────────────────────
  getSettings: () => fetch('/api/settings', opts).then(_json),
  saveSetting: (key, value) => fetch('/api/settings', { ...jsonOpts, method: 'PUT', body: JSON.stringify({ key, value }) }).then(_json),

  // ── Auth ───────────────────────────────────────────────────────────────
  getAuthStatus: () => fetch('/api/auth/status', opts).then(_json),
  getMe: () => fetch('/api/auth/me', opts).then(_json),
  login: (username, password) => fetch('/api/auth/login', { ...jsonOpts, method: 'POST', body: JSON.stringify({ username, password }) }).then(_json),
  logout: () => fetch('/api/auth/logout', { ...opts, method: 'POST' }).then(_json),
  setUserRole: (id, role) => fetch(`/api/auth/users/${id}/role`, { ...jsonOpts, method: 'PUT', body: JSON.stringify({ role }) }).then(_json),
  setUserTrainer: (id, trainer_id) => fetch(`/api/auth/users/${id}/trainer`, { ...jsonOpts, method: 'PUT', body: JSON.stringify({ trainer_id }) }).then(_json),

  // ── Trainer / Coaching ─────────────────────────────────────────────────
  getMyMembers: () => fetch('/api/trainer/members', opts).then(_json),
  getUnassignedMembers: () => fetch('/api/trainer/unassigned-members', opts).then(_json),
  claimCoachee: (memberId) => fetch(`/api/trainer/members/${memberId}`, { ...opts, method: 'POST' }).then(_json),
  removeCoachee: (memberId) => fetch(`/api/trainer/members/${memberId}`, { ...opts, method: 'DELETE' }).then(_json),
  getCoachActivity: (limit = 50) => fetch(`/api/trainer/activity?limit=${limit}`, opts).then(_json),
  markCoachActivitySeen: (id = null) => fetch('/api/trainer/activity/seen', { ...jsonOpts, method: 'POST', body: JSON.stringify(id ? { id } : {}) }).then(_json),
  updatePrescription: (id, data) => fetch(`/api/trainer/prescriptions/${id}`, { ...jsonOpts, method: 'PUT', body: JSON.stringify(data) }).then(_json),
  saveCoachFeedback: (data) => fetch('/api/trainer/feedback', { ...jsonOpts, method: 'POST', body: JSON.stringify(data) }).then(_json),
  getMemberOverview: (id) => fetch(`/api/trainer/members/${id}`, opts).then(_json),
  getMemberWorkout: (id, date) => fetch(`/api/trainer/members/${id}/workout/${date}`, opts).then(_json),
  getMemberPrescriptions: (id) => fetch(`/api/trainer/members/${id}/prescriptions`, opts).then(_json),
  createPrescription: (memberId, data) => fetch(`/api/trainer/members/${memberId}/prescriptions`, { ...jsonOpts, method: 'POST', body: JSON.stringify(data) }).then(_json),
  deletePrescription: (id) => fetch(`/api/trainer/prescriptions/${id}`, { ...opts, method: 'DELETE' }).then(_json),

  // Member-side prescription lookups
  getMyPrescriptionForDate: (date) => fetch(`/api/prescriptions/my/${date}`, opts).then(_json),
  getMyUpcomingPrescriptions: () => fetch('/api/prescriptions/my/upcoming/list', opts).then(_json),

  // ── Upload ─────────────────────────────────────────────────────────────
  uploadFile: async (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/upload', { ...opts, method: 'POST', body: fd }).then(_json);
  },

  // ── CORS proxy ─────────────────────────────────────────────────────────
  proxy: (url) => fetch(`/api/proxy?url=${encodeURIComponent(url)}`, opts).then(_json),
};
