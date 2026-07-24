# Reflection #2

Pod Members: **Della Lee, Daniel Lam, Audrey Dequito, Miguel Cueva**

## Reflection Questions

* Name at least one successful thing this week.

We deployed our website this week. Everything works end to end, and all of MVP 0 is finished and deployed. A user signs in to the app and goes through onboarding, where they fill out their preferences: favorite cuisine, budget, and location. They can create a group chat, add new members, and leave the group chat. In a session, each user talks to their own AI agent, and once every member has done so, the AI recommends restaurants that satisfy the whole group.

* What were some challenges you and/or your group faced this week?

One of our main challenges this week was fixing bugs before deploying, which took longer than we expected. Our biggest UI bug was the session window shrinking whenever someone typed. Beyond that, we worked through a batch of session and group-chat issues: removing the agent's dietary-restrictions question and adding one asking which cuisines the user dislikes; fixing the session so it ends once the host creates the event rather than only when the timer runs out; stopping the "join" button from being re-clickable after a session ends and having it switch to "results" when everyone's done or "waiting for others" when a user finishes early; making the "I'm finished" button more obvious; clearing the "active session" label when no session is live; updating the right side bar to reflect user corrections in "noted so far"; moving the AI's top picks from the group chat into the session chat and showing only the top 5 results (per Figma); displaying session members on the event; and replacing mock usernames like "user23" and "Sophie" with real ones.


* Did you finish all of your tasks in your sprint plan for this week? If you did not finish all of the planned tasks, how would you prioritize the remaining tasks on your list?  (i.e over planned, did not know how to implement certain features, miscommunication from the team, had to pivot from original plans, etc.)

We finished majority of the task that we planned for this week. Our biggest goal for this week was deploying our website, which we were able to accomplish. 

* Did the resources provided to you help prepare you in planning and executing your capstone project sprint this week? Be specific, what resources did you find particularly helpful or which tasks did you need more support on?

The resources we used were our mentors and documentation. When choosing how to deploy our ai_service, we looked into different deployment options and read the documentation to determine which would be the best fit. We considered Railway, Fly.io, and Render, and after reading the documentation and watching YouTube videos for each option, we decided to deploy our gateway and ai_service on Fly.io, and our database and frontend on Render.

* Which features and user stories would you consider “at risk”? How will you change your plan if those items remain “at risk”?

One feature that is "at risk" is the latency of the AI recommendation. It takes around 10 seconds for the AI to make a restaurant recommendation, which could lead to a poor user experience.
