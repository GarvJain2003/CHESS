import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
    // Add any API you want to expose to the renderer here
});
