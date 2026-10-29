# Changelog

## 0.4.1

- A long kickoff prompt on a **Start a new session** card starts folded to its first 4 lines, with **Show more** and **Show less**. The board remembers which ones you opened. A prompt that fits in 4 lines at the board's width shows whole, with no button.

## 0.4.0

- **Start next session** fills in the kickoff prompt for you. A slot left for your answer, such as `<looks fine / what's wrong>`, is asked first: pick a choice, or type your own words straight into the list. A choice like "what's wrong" opens a box for your words. The answer goes in the slot's place, and the summary shows the finished prompt. Text in backticks and one-word command placeholders such as `<id>` are never asked.
- **New session** does the same for a pasted first message.

## 0.3.2

- **Start next session** starts with the session's kickoff prompt even when its newest reply didn't repeat it: it takes the newest prompt any earlier reply wrote, and the summary says it came from an earlier reply.
- It also starts from the old session's own model and effort: both lists open on them ("Same as this session").
- Each card shows the last reply's effort beside its model, e.g. `Opus 5.5 · xhigh`.

## 0.3.1

- The model and the effort are now the last two questions, after the name, the folder and the first message.
- A summary comes last, before anything starts: name, folder, model, effort (naming the defaults when you chose Default) and the whole first message. Nothing runs until you press Start.

## 0.3.0

- Choose the model and the effort before a session starts, in **New session** and in **Start next session**. Each list opens on your last choice, and "Default" shows what your Claude Code settings would pick (the project's own settings first). Another model id can be typed in. The confirm box for the next session says which model and effort it will use. `switchboard.newSession.chooseModel` turns the two questions off.

## 0.2.2

- The to-do list no longer stacks up. When a session finishes a reply, its asks are matched to that reply: new ones are added, and the ones it no longer asks (you answered, it moved on) clear themselves. An ask that comes back later reopens. A session that has ended keeps its last asks until you tick them.
- Ticked items leave the list after a day. Your own items never clear themselves.

## 0.2.1

- A session that waits on you without asking a question ("the only thing left is your OK", "once you say go") now shows under **Waiting for your reply**, not Done.
- Claude Code's recap, when it comes after the reply, has the last word: "Next: reply …" or "Next, answer …" means it waits for you, "Next, I'll …" means it doesn't, and "Next, start … in a fresh session" means a new session.

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
