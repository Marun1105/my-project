# Climby social — the plan

The people side of Climby: profiles, search, friends, groups, chat, the currency
and its mountain, parent mode, and the look you want it to have. This replaces
Part 3, Part 4 and Part 6 of `plan-2026-09-climby-2.md`; the tutor parts of that
plan are built.

How to read it. Every line is one of three things, and says which:

- **Decided** — you said it. Your words, or as close as I could keep them.
- **Proposed** — mine. Nothing proposed gets built until you say yes to it.
- **Open** — a question only you can answer. They are collected at the end.

Nothing here is built yet.

---

## 0. What everything depends on: knowing how old someone is

Three of your rules need an age, not a grade:

- **Decided.** Groups can be created by anyone **above 12**.
- **Decided.** Parent mode works if the child is **under 16**, recommended for **9–14**.
- **Decided.** A human looks at a chat only when it is suspicious, **"like a 16 to
  8 year old"**.

Today Climby stores only the grade, typed by the student, and only for students.
A grade is not an age, and it is easy to get wrong on purpose.

**Proposed.** Ask for the **month and year of birth** at sign-up — not the day,
which is more than any rule here needs. Existing accounts are asked once, the
way the grade question is asked now. It can be corrected once by the student;
after that, only through support. Without this, none of the three rules above
can be enforced, so it is step one.

**Fact, not preference.** In Bulgaria the age at which a child can consent to an
online service processing their data is **14** (GDPR Article 8, set nationally).
Below 14, the social features — a profile others see, friends, chat — need a
parent's consent. That fits your parent mode: the parent link that already
exists becomes the place that consent is given.

**Proposed.** Under 14 and no parent linked: Climby works as it does today
(ClimbAI, homework, Focus, classes with a teacher's code). Profile, search,
friends and chat switch on when a parent approves, from the parent's own account.

---

## 1. The look — "like Bump"

**Decided.** You like Bump's look. Bump is a social app about places; Climby is
for studying. It is the look you want, not the idea.

**Still missing.** I have not seen Bump and will not guess. I need two or three
screenshots in `docs/design/` and which part you mean: the colours, the round
shapes, the density, the motion, the map-like feel. Those are different jobs.

**Proposed.** The social screens are designed after those screenshots arrive,
and they use the theme system that now exists (17 themes, Settings →
Appearance), so a "Bump-like" look can be one theme rather than a rebuild.

---

## 2. Profiles

**Decided.** Everyone has a profile, and others can see it — classmates,
friends, and other people.

**Decided.** A profile shows:

| Shown | |
|---|---|
| name, avatar, grade | the name a student chooses to show |
| the mountain and the currency | see section 7 |
| groups and mutual friends | which groups, and friends you have in common |

**Proposed — what it does not show.** Streaks, study minutes, tasks, questions to
ClimbAI, the town from the profile questions, the birth date. Not chosen by you;
I am listing them so they are not added by accident.

**Proposed — the avatar.** Generated avatars (a colour, a shape, a climber) and no
photo uploads for under-16s. A photo of a 13-year-old's face on a profile anyone
can search is the most-abused thing a social app for children can have.

**Decided.** There will be **privacy settings**.

**Proposed — the privacy settings.** Who can see my groups (everyone / friends /
nobody); who can send me friend requests (everyone / friends of friends /
nobody); show my mountain to (friends / everyone). Defaults in section 3.

---

## 3. Search

**Decided.** Friends are found through a **search of users**, and **anyone can
search anyone by username**.

**Decided.** Also through **friends of your friends**.

**Proposed — how a search result looks.** Name, avatar, grade, mutual friends.
Nothing else until a friend request is accepted.

**Proposed — the protections that fit your choice.** You chose open search; these
keep it open and make it harder to misuse:

1. Search needs at least 3 characters and returns at most 20 results, so the
   list of users cannot be scrolled through.
2. Searching is rate-limited per account.
3. **A friend request across a large age gap** (one of them under 16, and more
   than 3 years apart) is not delivered silently: the younger one sees the
   other's age range on the request, and it counts as "suspicious" for section 6.
4. Block works everywhere: a blocked person cannot find you, request you or
   message you.

---

## 4. Friends

**Decided.** It is a **friend request**; if he accepts, you are friends.

**Decided.** Once you are friends, you can **add him to other groups**.

**Proposed.**
- Requests can be accepted, declined (silently — the sender is not told) or
  blocked.
- "People you may know": friends of your friends, and people in your groups.
- Unfriending is silent and immediate.
- A limit of 20 pending requests sent at once, against spam.

---

## 5. Groups

**Decided.** A group is **not only a class**. It can connect people who share
something — for example **people who have the same concentration problem**.

**Decided.** Groups can be **created by anyone above 12**.

**Decided.** **Many things will need verification.**

**Proposed — the kinds of group.**

| Kind | Who makes it | How you join |
|---|---|---|
| Class | a teacher | the class code (exists today) |
| Friends group | anyone 12+ | invited by a friend |
| Open group (e.g. a concentration group) | anyone 12+ | request to join; the creator approves |

**Proposed — what "verification" means here.** A verified email to create any
group (exists); a confirmed birth date for 12+; teachers confirmed by their
school email domain before their groups are marked "class". Open: whether you
meant more than this.

**Proposed — inside a group.** Members, the group's combined study minutes this
week, and the members' mountains. Group chat only after one-to-one chat has run
safely for a while (section 6).

---

## 6. Chat

**Decided.** Chat is **between friends only** — you can chat with someone once
you are friends.

**Decided.** There will be **protections**.

**Decided.** Messages are **not kept forever**.

**Decided.** **A parent does not see chat.**

**Decided.** **Every message goes through an AI filter**, and **you see a chat
only if it is suspicious — like a 16-year-old talking to an 8-year-old.**

**Proposed — what the AI filter does with each message,** before delivery:

| The message | What happens |
|---|---|
| fine | delivered |
| clearly harmful — sexual content, threats, slurs | not delivered; the sender is told why |
| personal details — phone number, address, "meet me at…" | not delivered to an under-16; the sender is told |
| bullying or pressure | delivered, and the conversation is marked |

**Proposed — "suspicious", for your queue.** A conversation lands in front of
you when any of these is true:

1. One person is under 16 and the other is more than 3 years older (your "16 to
   8"); the threshold numbers are yours to set.
2. The filter held back personal details or a meeting place in it.
3. Someone in it pressed **Report**.
4. Bullying was marked more than once.

You see those conversations and nothing else. Everyone else's chat is read by
nobody.

**Proposed — what you get.** An email when something lands; a small private page
listing flagged conversations; buttons to warn, mute for a week, or ban. A
target of looking within 24 hours. This is the part of social that never
finishes once it ships: someone has to answer it, and right now that someone is
you.

**Proposed — the rest.**
- Kept **90 days**, then deleted from the server (you said "not forever"; the
  number is mine).
- Text and emoji only at first. No photos or files in chat for under-16s.
- Report and block on every message.
- No disappearing messages: they make reports impossible to check.

**Proposed — cost.** One Haiku check per message is about $0.0005; 10,000
messages a day is about $5 a day.

---

## 7. The currency and the mountain

**Decided.** A leaderboard for everybody is a bit dumb, so there is a
**currency** instead.

**Decided.** It is **visible to friends**, and it **never resets**.

**Proposed — earning** (from the September plan, still yours to accept):

| | why |
|---|---|
| Solved on your own | judged by the tutor, not claimed — the main earner, and it already exists |
| A task finished on time | rewards finishing, not starting |
| Focus minutes | capped per day, or it becomes "leave the camera on" |
| A streak day | small and steady |
| Taking the break when Climby suggests it | new: rewards stopping, not only grinding |

**Proposed — the rule I would not break.** The currency never buys anything that
helps you learn — no hints, no answers, no skips.

**Proposed — spending.** The mountain (more rock, then snow, then a flag); avatar
frames; the themes that exist now, some unlocked with the currency; gifting to a
friend; one streak shield at a time.

**Proposed — "never resets" and comparison.** The total only grows. Next to it,
"earned this week" — the number a group compares, so a newcomer is not behind
forever.

---

## 8. Parent mode

**Decided.** Works if the child is **under 16**, recommended **9–14**, and **not
anything creepy**. The parent **never sees chat**.

**Proposed — what "not creepy" means:**

| A parent sees | A parent never sees |
|---|---|
| minutes studied, which days | what the tasks say |
| tasks done and outstanding | questions to ClimbAI |
| solved-on-your-own count | any message, ever |
| which groups, how many friends | who the friends are |

**Proposed.** The child sees exactly this table, in the app, so nothing is a
surprise. The parent is where under-14 consent is given (section 0).

---

## 9. Notifications

**Built.** Break reminders during Focus (1.0.28) use a Windows notification.

**Proposed.** The same channel for: a friend request, a group invite, a message
(when Climby is not in front). Each can be switched off in Settings. Nothing at
night between 22:00 and 07:00.

---

## 10. How it is built

**Proposed**, for whoever builds it — you can skip this part.

- **Data.** On `users`: `birth_ym`, `avatar`, `display_name` reuse, privacy
  settings. New tables: `friend_requests`, `friendships`, `blocks`, `groups`,
  `group_members`, `messages` (with a 90-day delete), `message_flags`,
  `reports`, `wallet_ledger` (every earn and spend, so a balance can always be
  recomputed), `purchases`.
- **Delivery.** Chat polls every few seconds while open, the way the phone link
  already does; real-time sockets are not needed at this size and Render's free
  plan sleeps.
- **The filter.** A Haiku call per message with a fixed rubric, returning one of
  the four outcomes in section 6, written to `message_flags`.
- **Your queue.** A private page behind an admin role, plus an email per flag.
- **Tests.** Postgres-only traps (booleans, NULLs) checked as they are now; a
  test per protection in sections 3 and 6.
- **Data rights.** Export and account deletion (which exist) extended to every
  new table; messages deleted on both sides when an account is deleted.

---

## 11. Order

**Proposed.**

1. Birth month and year, and the under-14 parent consent (section 0).
2. Profiles and avatars, with privacy settings.
3. Search and friends.
4. The currency and the mountain.
5. Groups.
6. Chat, with the filter and your queue — last, because it is the piece that
   needs someone answering it.
7. The look, as soon as the Bump screenshots exist.

Each step is a release on its own.

---

## Answers, 2026-10-18

- **Age:** month and year of birth at sign-up; existing accounts are asked once.
  **Under 12** the social parts switch on only after a parent approves.
  ⚠ Open legal point: Bulgaria's consent age for online services is **14**
  (GDPR Art. 8). For 12–13-year-olds, consent-based processing of a public
  profile/chat still needs a parent's consent unless another legal basis
  applies. Decide before step 1 ships — the simplest safe rule is 14.
- **Suspicious chat:** under 16 and 3+ years apart, plus the AI filter always.
- **Avatars:** real photos allowed for everyone (shown to friends only, per
  the privacy settings in section 2).
- **Database:** not yet — no new tables until the owner says go.
- **Messages:** kept until the student deletes them — a message, a chat, or the
  whole chat history (and with the account). This replaces "not kept forever"
  in section 6. Deleting removes them from the server, not just the screen.
- **Bump look** (screenshot seen 2026-10-18, not stored here — it is another
  company's marketing image and this repo is public): huge bold condensed
  italic headlines on the screen itself ("5 countries", "Arrive in 18mins");
  a soft map-like background; round avatars as bubbles, a glowing green ring
  for "live"; small white pills for stats ("92%"); floating white rounded
  cards with one big round action button; a holographic round main button at
  the bottom centre; saturated violet-blue. For Climby: the mountain screen
  and profiles in this style, as their own look, not the whole app.
- **The currency is "Holds" (Хватки)** — the grips on a climbing wall. Earned
  by studying, spent to build the mountain hold by hold. Icons: colourful
  hold-shaped blobs. Example: "+3 holds — solved it on your own". Replaces the
  "Coins" placeholder everywhere in this plan.
- Still open: verification (4).

## The questions still open

1. **Bump**: two or three screenshots, and which part of the look you mean.
2. **Age**: is month and year of birth at sign-up all right? And the under-14
   rule — social features only with a parent's approval?
3. **"Suspicious" in numbers**: under what age, and how many years apart?
   (I wrote under 16 and more than 3 years.)
4. **Verification**: does section 5 cover what you meant, or more?
5. **Avatars**: generated only for under-16s, or photos too?
6. ~~The currency's name.~~ Decided: Holds (Хватки).
7. ~~Message retention.~~ Decided: until the student deletes them.
