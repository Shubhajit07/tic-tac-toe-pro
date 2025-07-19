document.addEventListener('DOMContentLoaded', () => {
    const WEBSOCKET_URL = `ws://${window.location.host}/ws/`;

    // --- DOM Elements ---
    const homeScreen = document.getElementById('home-screen');
    const gameScreen = document.getElementById('game-screen');
    const newGameBtn = document.getElementById('new-game-btn');
    const joinGameBtn = document.getElementById('join-game-btn');
    const roomCodeInput = document.getElementById('room-code-input');
    const homeErrorMsg = document.getElementById('home-error-msg');
    const backToHomeBtn = document.getElementById('back-to-home-btn');

    const gameBoard = document.getElementById('game-board');
    const gameIdDisplay = document.getElementById('game-id-display');
    const turnInfo = document.getElementById('turn-info');
    const copyButton = document.getElementById('copy-button');
    const connectionStatus = document.getElementById('connection-status');
    const statusText = document.getElementById('status-text');
    const modal = document.getElementById('game-over-modal');
    const modalMessage = document.getElementById('modal-message');
    const playAgainButton = document.getElementById('play-again-button');
    const winningLine = document.getElementById('winning-line');
    const startGameBtn = document.getElementById('start-game-btn');

    // --- Game State ---
    let ws;
    let clientId = localStorage.getItem('ttt-clientId') || `client_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('ttt-clientId', clientId);

    let state = {};

    function resetState() {
        state = {
            gameId: null, playerSymbol: null, board: Array(9).fill(""),
            nextPlayer: null, winner: null, win_condition: null, players: [],
            started: false,
        };
    }

    // --- Screen Management ---
    function showScreen(screenName) {
        homeScreen.classList.add('hidden');
        gameScreen.classList.add('hidden');
        document.getElementById(`${screenName}-screen`).classList.remove('hidden');
    }

    // --- WebSocket Logic ---
    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;
        ws = new WebSocket(`${WEBSOCKET_URL}${clientId}`);

        ws.onopen = () => {
            console.log('Connected to WebSocket server');
            updateConnectionStatus(true);
            const urlParams = new URLSearchParams(window.location.search);
            const gameIdFromUrl = urlParams.get('game');
            if (gameIdFromUrl) {
                roomCodeInput.value = gameIdFromUrl;
                handleJoinGame();
            }
        };
        ws.onmessage = (event) => handleMessage(JSON.parse(event.data));
        ws.onclose = () => {
            console.log('Disconnected. Attempting to reconnect...');
            updateConnectionStatus(false);
            setTimeout(connect, 3000);
        };
        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            updateConnectionStatus(false);
            ws.close();
        };
    }

    function sendMessage(payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    function handleMessage(message) {
        console.log('Received:', message);
        let playerIndex;
        switch (message.type) {
            case 'game_created':
                resetState();
                Object.assign(state, message.state);
                // The creator is always Player 1 (X)
                state.playerSymbol = 'X'; 
                history.pushState(null, '', `?game=${state.gameId}`);
                showScreen('game');
                updateUI();
                break;

            case 'game_update':
                // Always accept the server's state as the source of truth
                Object.assign(state, message.state);

                // THE FINAL FIX: Authoritatively derive the symbol from the players list
                playerIndex = state.players.indexOf(clientId);
                if (playerIndex === 0) {
                    state.playerSymbol = 'X';
                } else if (playerIndex === 1) {
                    state.playerSymbol = 'O';
                } else {
                    // This client is a spectator or something is wrong
                    state.playerSymbol = null; 
                }
                
                // Update URL and show the game screen if not already visible
                if (state.gameId && !window.location.search.includes(state.gameId)) {
                    history.pushState(null, '', `?game=${state.gameId}`);
                }
                showScreen('game');
                updateUI();
                break;

            case 'error':
                showHomeError(message.message);
                break;
            case 'game_restarted':
                resetState();
                Object.assign(state, message.state);
                // Re-assign player symbol
                playerIndex = state.players.indexOf(clientId);
                if (playerIndex === 0) {
                    state.playerSymbol = 'X';
                } else if (playerIndex === 1) {
                    state.playerSymbol = 'O';
                } else {
                    state.playerSymbol = null;
                }
                modal.classList.add('hidden');
                showScreen('game');
                updateUI();
                break;
        }
    }

    // --- UI Update & Event Handlers ---
    function updateUI() {
        console.log('UI State:', state);
        if (!state.gameId) return;
        gameIdDisplay.textContent = state.gameId;
        renderBoard();
        updateTurnInfo();
        if (state.winner) {
            showGameOver();
        }

        // Show Start Game button logic
        if (
            state.players && state.players.length === 2 &&
            state.started === false &&
            state.playerSymbol === 'X'
        ) {
            startGameBtn.classList.remove('hidden');
        } else {
            startGameBtn.classList.add('hidden');
        }
    }
    
    function showHomeError(message) {
        homeErrorMsg.textContent = message;
        homeErrorMsg.classList.remove('hidden');
        setTimeout(() => {
            homeErrorMsg.classList.add('hidden');
            homeErrorMsg.textContent = '';
        }, 3000);
    }

    function handleNewGame() {
        sendMessage({ action: 'create_game' });
    }

    function handleJoinGame() {
        const roomCode = roomCodeInput.value.trim().toLowerCase();
        if (roomCode.length > 0) {
            sendMessage({ action: 'join_game', game_id: roomCode });
        } else {
            showHomeError("Please enter a room code.");
        }
    }
    
    function handleBackToHome() {
        resetState();
        history.pushState(null, '', '/');
        showScreen('home');
        roomCodeInput.value = '';
        modal.classList.add('hidden');
    }
    
    function handlePlayAgain() {
        modal.classList.add('hidden');
        handleBackToHome();
    }

    function handleCellClick(index) {
        sendMessage({
            action: 'make_move',
            game_id: state.gameId,
            player_symbol: state.playerSymbol,
            index: index
        });
    }

    function updateTurnInfo() {
        if (state.winner) {
            turnInfo.textContent = `Game Over!`;
            turnInfo.style.color = 'var(--font-color)';
        } else if (!state.players || state.players.length < 2) {
            turnInfo.textContent = 'Waiting for another player...';
            turnInfo.style.color = 'var(--font-color)';
        } else if (state.started === false) {
            turnInfo.textContent = 'Waiting for game to start...';
            turnInfo.style.color = 'var(--font-color)';
        } else if (state.next_player) {
            if (state.next_player === state.playerSymbol) {
                turnInfo.textContent = `Your turn (${state.playerSymbol})`;
                turnInfo.style.color = 'var(--accent-color)';
            } else {
                turnInfo.textContent = `Opponent's turn (${state.next_player})`;
                turnInfo.style.color = 'var(--font-color)';
            }
        }
    }
    
    function renderBoard() {
        gameBoard.innerHTML = '';
        winningLine.style.display = 'none';
        state.board.forEach((cell, index) => {
            const cellEl = document.createElement('div');
            cellEl.classList.add('cell');
            if (cell) {
                cellEl.textContent = cell;
                cellEl.classList.add(cell.toLowerCase());
            }
            const isMyTurn = state.playerSymbol === state.next_player;
            const isGameOver = !!state.winner;
            const hasTwoPlayers = state.players && state.players.length === 2;
            const gameStarted = state.started === true;

            if (!isGameOver && isMyTurn && !cell && hasTwoPlayers && gameStarted) {
                cellEl.addEventListener('click', () => handleCellClick(index));
            } else {
                cellEl.classList.add('disabled');
            }
            gameBoard.appendChild(cellEl);
        });
    }

    function showGameOver() {
        if (state.winner === 'Draw') {
            modalMessage.textContent = "It's a draw!";
        } else {
            modalMessage.textContent = `Player ${state.winner} wins!`;
        }
        if (state.win_condition) {
            drawWinningLine(state.win_condition);
            // Show animation for 1s, then show modal
            setTimeout(() => {
                modal.classList.remove('hidden');
            }, 1000);
        } else {
            // No win line, show modal immediately
            modal.classList.remove('hidden');
        }
    }
    
    function drawWinningLine(condition) {
        if (!condition) return;
        // If condition is a string, parse it
        if (typeof condition === 'string') {
            try {
                condition = JSON.parse(condition);
            } catch (e) {
                return; // Invalid format, do nothing
            }
        }
        const [a, b, c] = condition;
        const cellA = gameBoard.children[a];
        const cellC = gameBoard.children[c];
        if (!cellA || !cellC) return;
        const boardRect = gameBoard.getBoundingClientRect();
        const startRect = cellA.getBoundingClientRect();
        const endRect = cellC.getBoundingClientRect();
        const startX = startRect.left + startRect.width / 2 - boardRect.left;
        const startY = startRect.top + startRect.height / 2 - boardRect.top;
        const endX = endRect.left + endRect.width / 2 - boardRect.left;
        const endY = endRect.top + endRect.height / 2 - boardRect.top;
        const angle = Math.atan2(endY - startY, endX - startX) * 180 / Math.PI;
        const length = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
        winningLine.style.width = `${length}px`;
        winningLine.style.top = `${startY}px`;
        winningLine.style.left = `${startX}px`;
        winningLine.style.transform = `rotate(${angle}deg)`;
        winningLine.style.display = 'block';
    }

    function updateConnectionStatus(isConnected) {
        if (isConnected) {
            connectionStatus.className = 'status-connected';
            statusText.textContent = 'Connected';
        } else {
            connectionStatus.className = 'status-disconnected';
            statusText.textContent = 'Reconnecting...';
        }
    }

    // Add event listeners
    newGameBtn.addEventListener('click', handleNewGame);
    joinGameBtn.addEventListener('click', handleJoinGame);
    roomCodeInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') handleJoinGame(); });
    backToHomeBtn.addEventListener('click', handleBackToHome);
    playAgainButton.addEventListener('click', handlePlayAgain);
    copyButton.addEventListener('click', () => {
        if (!state.gameId) return;
        navigator.clipboard.writeText(window.location.href).then(() => {
            copyButton.textContent = '✅';
            setTimeout(() => copyButton.textContent = '📋', 1500);
        });
    });

    startGameBtn.addEventListener('click', () => {
        sendMessage({ action: 'start_game', game_id: state.gameId });
        startGameBtn.classList.add('hidden');
    });

    // Add event listener for restart game
    const restartGameBtn = document.getElementById('restart-game-btn');
    if (restartGameBtn) {
        restartGameBtn.addEventListener('click', () => {
            sendMessage({ action: 'restart_game', game_id: state.gameId });
        });
    }

    // --- Initial Load ---
    resetState();
    connect();
});