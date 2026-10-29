# Changelog

## 0.2.0

- A to-do list at the top of the board. What Claude asks you to do ("Needs you: …") lands there by itself; add your own, or put a card on the list with its to-do button. It is shared by every VS Code window and outlives the session.
- Each card shows its context and its cost at API prices (helper agents included, breakdown on hover), and the model of its last reply.
- Nothing on a card is cut short any more: titles, folders and Claude's words wrap, and **Show the whole reply** opens the whole last reply.
- A default board width (440 pixels, `switchboard.board.width`), set the first time the board opens.

## 0.1.0

- First release: a board of every Claude Code session on the machine, in coloured sections: Needs you, Waiting for your reply, Start a new session, Stopped, Done, Working and Idle.
- Each card shows the title, folder, age, a context meter and what Claude last said: the question it asks, its recap, or the error.
- Start next session: a hand-over card opens a new session in the same folder with the kickoff prompt as its first message, or copies the prompt.
- Click a session to bring its terminal tab forward, or to attach to a background session.
- A status-bar counter, and pop-ups with an Open button when a session needs you or finishes a turn.
- A New session button: name, folder and first task.
