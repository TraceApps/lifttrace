// platform.js for a phone connected to the server in LT_SERVER as LT_TOKEN.
const server = () => process.env.LT_SERVER || null;
let tok = process.env.LT_TOKEN || null;
export const isNative = true;
export const getServerUrl = server;
export const getAuthToken = () => tok;
export const setAuthToken = t => { tok = t; };
export const apiUrl = p => (server() || '') + p;
export const authHeaders = (extra = {}) => ({ ...extra, ...(tok ? { Authorization: `Bearer ${tok}` } : {}) });
export const resolveAssetUrl = x => x;
export const getNativeMode = () => (server() ? 'server' : 'local');
export const setNativeMode = () => {};
export const setServerUrl = () => {};
export const needsNativeSetup = () => false;
export const iconUrl = x => x;
export const loadImageMap = async () => ({});
export const setImageMap = () => {};
export const explainConnectError = e => String(e);
