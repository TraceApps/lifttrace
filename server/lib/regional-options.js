/**
 * The settings an admin can give everyone a default for (from
 * nutritrace#326), with the values LiftTrace offers for each and the
 * environment variable that sets and locks it. Kept in server/lib because
 * the server image has no src/.
 *
 * The weight unit isn't here on purpose: a logged set is a bare number in
 * the account's unit, so a default that changed for someone who never
 * chose would read their 225 lbs as 225 kg.
 */
export const REGIONAL_OPTIONS = {
  language:   { env: 'DEFAULT_LANGUAGE',    values: ['en', 'es', 'it', 'ru', 'zh-Hans'] },
  dateFormat: { env: 'DEFAULT_DATE_FORMAT', values: ['US', 'EU', 'ISO'] },
  timeFormat: { env: 'DEFAULT_TIME_FORMAT', values: ['12h', '24h'] },
};
