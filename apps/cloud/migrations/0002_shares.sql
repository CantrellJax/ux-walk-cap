create table "share" (
	"id" text not null primary key,
	"owner" text not null,
	"title" text not null,
	"contentType" text not null,
	"size" integer not null,
	"status" text not null check ("status" in ('pending', 'ready', 'revoked')),
	"createdAt" integer not null,
	"expiresAt" integer not null,
	"completedAt" integer,
	"revokedAt" integer
);

create index "share_owner_status_idx" on "share" ("owner", "status", "expiresAt");
