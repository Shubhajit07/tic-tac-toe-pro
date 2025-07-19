import json
import uuid
import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
import redis.asyncio as redis
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(os.path.dirname(BASE_DIR), "frontend")

app = FastAPI()

origins = [
    "http://localhost",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
        self.active_connections: dict[str, list[WebSocket]] = {}
        self.redis = redis.from_url(redis_url, decode_responses=True)

    def connect(self, websocket: WebSocket, game_id: str):
        if game_id not in self.active_connections:
            self.active_connections[game_id] = []
        self.active_connections[game_id].append(websocket)

    def disconnect(self, websocket: WebSocket, game_id: str):
        if game_id in self.active_connections and websocket in self.active_connections[game_id]:
            self.active_connections[game_id].remove(websocket)

    async def broadcast(self, message: dict, game_id: str):
        if game_id in self.active_connections:
            for connection in self.active_connections[game_id]:
                await connection.send_text(json.dumps(message))

manager = ConnectionManager()

def check_winner(board):
    winning_conditions = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6],
        [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]
    ]
    for condition in winning_conditions:
        a, b, c = condition
        if board[a] and board[a] == board[b] == board[c]:
            return board[a], condition
    if "" not in board:
        return "Draw", None
    return None, None

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await websocket.accept()
    game_id = None
    try:
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"type": "error", "message": "Invalid message format."}))
                continue
            action = message.get("action")

            if action == "create_game":
                game_id = str(uuid.uuid4())[:8].lower()
                game_state = {
                    "gameId": game_id, "board": [""] * 9, "next_player": None,
                    "winner": None, "win_condition": None, "players": [client_id], "started": False
                }
                await manager.redis.set(f"game:{game_id}", json.dumps(game_state))
                await manager.redis.expire(f"game:{game_id}", 900)  # Expire empty room in 15 minutes
                manager.connect(websocket, game_id)
                await websocket.send_text(json.dumps({"type": "game_created", "state": game_state}))
                print(f"Game created: {game_id}, state: {game_state}")

            elif action == "join_game":
                game_id = message.get("game_id", "").lower()
                if not game_id or len(game_id) != 8:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Invalid game ID."}))
                    continue
                game_state_raw = await manager.redis.get(f"game:{game_id}")
                if not game_state_raw:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Game not found"}))
                    continue
                game_state = json.loads(game_state_raw)
                if len(game_state["players"]) >= 2 and client_id not in game_state["players"]:
                    await websocket.send_text(json.dumps({"type": "error", "message": "Game is full"}))
                    continue
                if client_id not in game_state["players"]:
                    game_state["players"].append(client_id)
                await manager.redis.set(f"game:{game_id}", json.dumps(game_state))
                manager.connect(websocket, game_id)
                await manager.broadcast({"type": "game_update", "state": game_state}, game_id)
                print(f"Game joined: {game_id}, state: {game_state}")
            elif action == "start_game":
                game_id = message.get("game_id", "").lower()
                game_state_raw = await manager.redis.get(f"game:{game_id}")
                if not game_state_raw:
                    continue
                game_state = json.loads(game_state_raw)
                # Only allow if two players and not already started
                if not game_state.get("started") and len(game_state["players"]) == 2:
                    game_state["started"] = True
                    game_state["next_player"] = "X"
                    await manager.redis.set(f"game:{game_id}", json.dumps(game_state))
                    await manager.broadcast({"type": "game_update", "state": game_state}, game_id)
                    print(f"Game started: {game_id}, state: {game_state}")
            elif action == "make_move":
                game_id = message.get("game_id", "").lower()
                index = message.get("index")
                move_player_symbol = message.get("player_symbol")
                if not game_id or not isinstance(index, int) or move_player_symbol not in ("X", "O"):
                    continue
                game_state_raw = await manager.redis.get(f"game:{game_id}")
                if not game_state_raw:
                    continue
                game_state = json.loads(game_state_raw)
                if (game_state["winner"] or len(game_state["players"]) < 2 or
                    not game_state.get("started") or
                    move_player_symbol != game_state["next_player"] or
                    game_state["board"][index] != ""):
                    continue
                game_state["board"][index] = move_player_symbol
                winner, win_condition = check_winner(game_state["board"])
                if winner:
                    game_state["winner"] = winner
                    game_state["win_condition"] = win_condition
                    # Set Redis expiry for this game to 15 minutes after game over
                    await manager.redis.set(f"game:{game_id}", json.dumps(game_state))
                    await manager.redis.expire(f"game:{game_id}", 900)
                else:
                    game_state["next_player"] = "O" if move_player_symbol == "X" else "X"
                await manager.redis.set(f"game:{game_id}", json.dumps(game_state))
                await manager.broadcast({"type": "game_update", "state": game_state}, game_id)
                print(f"Game updated: {game_id}, state: {game_state}")
            elif action == "restart_game":
                game_id = message.get("game_id", "").lower()
                game_state_raw = await manager.redis.get(f"game:{game_id}")
                if not game_state_raw:
                    continue
                game_state = json.loads(game_state_raw)
                # Only allow restart if there are two players
                if len(game_state["players"]) == 2:
                    game_state["board"] = [""] * 9
                    game_state["winner"] = None
                    game_state["win_condition"] = None
                    game_state["started"] = False
                    game_state["next_player"] = None
                    await manager.redis.set(f"game:{game_id}", json.dumps(game_state))
                    await manager.redis.persist(f"game:{game_id}")  # Remove expiry on restart
                    await manager.broadcast({"type": "game_restarted", "state": game_state}, game_id)
                    print(f"Game restarted: {game_id}, state: {game_state}")
    except WebSocketDisconnect:
        if game_id:
            manager.disconnect(websocket, game_id)
            await manager.broadcast({"type": "player_disconnected", "client_id": client_id}, game_id)
    except Exception as e:
        print(f"Error in WebSocket: {e}")
        if game_id:
            manager.disconnect(websocket, game_id)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def read_root():
    return FileResponse(os.path.join(STATIC_DIR, 'index.html'))