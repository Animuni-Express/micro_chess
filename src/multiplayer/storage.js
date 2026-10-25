const DATABASE = 'micro-chess-temporary';
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Temporary game storage is unavailable.'));
  });
}
export async function storeSession(value) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      if (value) tx.objectStore('sessions').put(value, 'active');
      else tx.objectStore('sessions').delete('active');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
export async function loadSession() {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('sessions').objectStore('sessions').get('active');
      request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
