# Reflection #1

Pod Members: **Della Lee, Daniel Lam, Audrey Dequito, Miguel Cuevas**

## Reflection Questions

- Name at least one successful thing this week.

This week we got our MVP 0 done. The core feature is implemented end to end. A group can be created with live username search, members chat in real time over WebSocket (with typing indicators and persistent messages), and the AI recommendation pipeline runs off the seeded restaurant catalog. Getting the full path working across frontend, gateway, and the AI service.

- What were some challenges you and/or your group faced this week?

Although our core feature was implemented, our app wasn't working during the demo. The session started crashing and the app didn't work. We have to debug and do more testing for the final demo.

- Did you finish all of your tasks in your sprint plan for this week? If you did not finish all of the planned tasks, how would you prioritize the remaining tasks on your list? (i.e over planned, did not know how to implement certain features, miscommunication from the team, had to pivot from original plans, etc.)

We finished all the tasks in our sprint plan this week. We'd planned to complete our MVP 0, and we got it done — the core features are implemented end to end: the traced frontend, real-time group chat, group creation and management, the AI recommendation pipeline, and the Prisma schema with seeded restaurant data.

- Did the resources provided to you help prepare you in planning and executing your capstone project sprint this week? Be specific, what resources did you find particularly helpful or which tasks did you need more support on?

We learned how the system connects end to end. Database -> backend -> frontend, and how a single request flows through all three layers. We also learned how user stories shape the wireframe and how the wire frames shape the frontend: staring from what the user needs, to the UI design, to the actual data flow.

- Which features and user stories would you consider “at risk”? How will you change your plan if those items remain “at risk”?

Voice input (STT/TTS) is our biggest at-risk feature — it's a headline part of the pitch but still just empty stubs, with no working implementation. If it stays at risk, we'll treat it as a stretch goal: ship text chat as the primary path, keep the mic as a thin wrapper that falls back to text, and wire up just one provider (Whisper) if time allows rather than the full voice round-trip.
