/**
 * exercise-owner.js: may this request change this exercise row?
 *
 * Only a custom exercise of its own. Library rows are shared by every user
 * on the instance, and another user's custom rows are theirs. The write
 * paths used to check neither, so any signed-in member could rename a
 * library exercise for everyone, or rewrite or delete someone else's private
 * one, just by knowing its id: through the edit route, the delete route and
 * the phone's sync push alike.
 *
 * The app only ever offers Edit and Delete on your own exercises, and a
 * phone only pushes rows it made, so this refuses nothing the app itself
 * does.
 *
 * With user management off there are no users: uid() is null, and so is
 * created_by on every row that operator made, so the same comparison holds.
 * Admins get no exception, the same as progress photos and set videos.
 */
export function canChangeExercise(row, userId) {
  if (!row || Number(row.is_global) !== 0) return false;
  const owner = row.created_by == null ? null : Number(row.created_by);
  const me = userId == null ? null : Number(userId);
  return owner === me;
}
