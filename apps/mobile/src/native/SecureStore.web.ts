// The experimental browser client keeps connection credentials for this tab.
// This is browser session storage, not an operating-system keychain.
const storageKey = (key: string) => `t3code:native-web:${key}`;
export const getItem = (key: string) => sessionStorage.getItem(storageKey(key));
export const setItem = (key: string, value: string) =>
  sessionStorage.setItem(storageKey(key), value);
export const deleteItem = (key: string) => sessionStorage.removeItem(storageKey(key));
export const getItemAsync = async (key: string) => getItem(key);
export const setItemAsync = async (key: string, value: string) => setItem(key, value);
export const deleteItemAsync = async (key: string) => deleteItem(key);
export const isAvailableAsync = async () => false;
