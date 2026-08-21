**Subject: Two new invoicing pieces are ready — here's what to look at**

Hi Brittany,

Two things you asked for are live: the **auto-advancing date ranges** on
reimbursed expenses, and **retainer invoicing**. Below is what each one does and
exactly what to check. Budget about 20 minutes.

---

### First — one important note before you touch anything

**Card and bank payments are now switched on for real money.** Any invoice you
send from here is a real invoice, and any payment link that gets clicked moves
real funds. So while you're kicking the tires, use the **Test** client (it's in
your client list) rather than a real one. Everything below works exactly the
same there.

Also worth knowing up front: **neither feature has changed anything on your
existing invoices.** Covered dates are switched off on all 34 of your recurring
charges until you turn one on, and no retainer invoices exist yet. Nothing moved
underneath you — these are both waiting for you to start using them.

---

## 1. Covered dates on reimbursed expenses (the QBO date range)

**What it does:** you write the wording once, enter the first date window once,
and from then on every invoice moves the window forward on its own and writes
the fresh dates into the line.

**To set one up:** open a client → **Recurring reimbursements** → pick one of
your QuickBooks charges → turn on **covered dates**. You'll enter two things:

- The wording, with `{range}` where the dates should appear —
  for example: `QuickBooks Online — {range}`
- The first window — for example **July 13 to August 13, 2026**

A preview on that card shows you exactly what the client will read. If the
preview looks right, the invoice will look right.

**What to check:**

1. **The wording reads the way you'd write it.** Generate this month's invoice
   for that client and look at the reimbursement line. It should say your
   sentence with the real dates filled in — *QuickBooks Online — July 13 –
   August 13, 2026* — not `{range}`, and not last cycle's dates.

2. **Next month moves on its own.** Generate the following month. The same line
   should now read *August 13 – September 13* without you touching anything.
   This is the whole point of the feature — if it advances correctly here,
   you're done retyping dates.

3. **It stops and asks when it isn't sure.** This is the part worth testing
   deliberately, because it's what protects you. Skip a month — generate August,
   then jump to October — and the line should **refuse to guess**. It will flag
   *Confirm the covered dates*, propose a window, and hold the invoice from being
   reviewed or sent until you confirm or correct it. Same thing happens if you
   pause a charge and resume it, or rebuild an older month.

4. **Voiding doesn't lose a window.** Void a month you already billed, then
   generate it again. It should reuse the same dates rather than skipping ahead
   a cycle.

5. **Your own typing always wins.** If you hand-edit the wording on a particular
   invoice line, that stays exactly as you typed it and never gets overwritten.

One small behavior to know: if you correct a window onto a different day of the
month, the cycle follows *your* day from then on. So if you move it to the 15th,
it stays on the 15th.

---

## 2. Retainer invoicing

**What it does:** bills the retainer at the start of an engagement, and gives
that money back as a credit on the final invoice — without you doing the math by
hand.

**To issue one:** open a client → **Issue retainer invoice** → enter the amount.
It becomes an ordinary invoice you review, send, and collect on like any other,
numbered `INV-RET-…` and tagged **Retainer** in the month run and in History.

**What to check:**

1. **It behaves like a normal invoice.** Issue one on the Test client. It should
   show up in your month run, be reviewable and sendable, and take payment
   through the usual link.

2. **The credit is offered, never automatic.** Once that retainer invoice is
   **paid**, open another draft invoice for the same client. You should see
   **Apply retainer INV-RET-… credit ($X)** as an option. Nothing applies itself
   — you decide which invoice is the final one.

3. **The credit lands where you'd expect.** Apply it. A negative *Retainer
   applied — credit* line should appear beneath the subtotal, like an
   adjustment, and the balance should drop by exactly the retainer amount.

4. **It can't be spent twice.** Apply it to one invoice, then check another
   draft for the same client — the offer should be gone. (Remove the credit line
   and it becomes available again.)

5. **A fully covered invoice sends politely.** If the credit wipes the balance to
   zero, the invoice should send as a statement with no payment button — the
   client shouldn't be asked to pay $0.

You may also notice two guardrails: the credit is only offered on invoices that
**haven't been sent yet** (a sent invoice has to keep matching what the client
received), and voiding a retainer that's already applied somewhere is refused,
with a pointer to the invoice holding it.

---

### One decision I need from you

Right now, a paid retainer invoice's line is still editable like any other
invoice, and the credit re-sizes to match whatever the invoice currently totals.

The alternative is to **freeze the credit at the amount actually paid**, so it
can never drift from the money that came in. For a retainer specifically, that
may be what you want. Tell me which you'd prefer and I'll make it the rule.

---

If anything reads wrong — the dates land oddly, the credit doesn't behave, the
wording isn't how you'd say it — send it back in the app with what you saw and
what you expected. That's usually enough for me to find it quickly.

Alex
