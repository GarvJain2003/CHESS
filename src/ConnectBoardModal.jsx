import React, { useState } from 'react';

/**
 * A simple modal component used to connect a hardware chess board.
 *
 * This implementation acts as a placeholder to satisfy the imports in the
 * main application. If you plan to support a physical chess board or
 * Bluetooth hardware integration, you can expand this modal with form
 * fields and logic to capture the board ID, player names, etc. When the
 * modal form is submitted, call the provided `onConnect` callback with
 * an object containing the details necessary to set up the hardware game.
 *
 * Props:
 *  - onClose: function called when the modal should be closed
 *  - onConnect: function called with an object containing board setup data
 */
export function ConnectBoardModal({ onClose, onConnect }) {
  const [boardCode, setBoardCode] = useState('');
  const [whiteName, setWhiteName] = useState('');
  const [blackName, setBlackName] = useState('');

  const handleConnect = () => {
    // Basic validation: ensure a board code has been entered
    if (!boardCode.trim()) return;
    onConnect({ boardCode: boardCode.trim(), whiteName, blackName });
  };

  return (
    <div className="fixed inset-0 flex items-end sm:items-center justify-center bg-black bg-opacity-70 z-50">
      <div className="bg-gray-800 p-6 sm:p-6 rounded-t-2xl sm:rounded-md w-full max-w-lg sm:max-w-md shadow-xl">
        <h2 className="text-2xl font-bold text-white mb-4">Connect Hardware Board</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Board Code</label>
            <input
              type="text"
              value={boardCode}
              onChange={(e) => setBoardCode(e.target.value)}
              placeholder="Enter board code"
              className="w-full px-3 py-2 bg-gray-700 text-white rounded-md border border-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">White Player Name</label>
            <input
              type="text"
              value={whiteName}
              onChange={(e) => setWhiteName(e.target.value)}
              placeholder="Optional: name for white"
              className="w-full px-3 py-2 bg-gray-700 text-white rounded-md border border-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">Black Player Name</label>
            <input
              type="text"
              value={blackName}
              onChange={(e) => setBlackName(e.target.value)}
              placeholder="Optional: name for black"
              className="w-full px-3 py-2 bg-gray-700 text-white rounded-md border border-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>
        <div className="mt-6 flex flex-col sm:flex-row sm:justify-end sm:space-x-4 space-y-3 sm:space-y-0">
          <button
            className="w-full sm:w-auto px-5 py-3 bg-gray-600 text-white rounded-md hover:bg-gray-700"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="w-full sm:w-auto px-5 py-3 bg-green-600 text-white rounded-md hover:bg-green-700"
            onClick={handleConnect}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
