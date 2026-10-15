"""Separate job leads from publishable jobs and preserve collection metrics."""

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""CREATE TABLE intake_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        run_key varchar(64) NOT NULL, source varchar(32) NOT NULL,
        started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL,
        status varchar(24) NOT NULL, artifact_hash varchar(64) NOT NULL,
        stats jsonb NOT NULL DEFAULT '{}', CONSTRAINT uq_intake_run_key UNIQUE(run_key)
    )""")
    op.execute("""CREATE TABLE job_leads (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        source varchar(32) NOT NULL, external_id varchar(100) NOT NULL, source_url text NOT NULL,
        title text NOT NULL, company text NOT NULL, location_text text, employer_url text,
        first_observed_at timestamptz NOT NULL, last_observed_at timestamptz NOT NULL,
        last_run_id uuid NOT NULL REFERENCES intake_runs(id),
        state varchar(32) NOT NULL DEFAULT 'pending', reason text,
        attempts integer NOT NULL DEFAULT 0, next_check_at timestamptz, last_checked_at timestamptz,
        job_id uuid REFERENCES jobs(id), evidence jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT uq_job_leads_source_external UNIQUE(source, external_id)
    )""")
    op.create_index("ix_job_leads_retry", "job_leads", ["next_check_at"])


def downgrade():
    op.drop_table("job_leads")
    op.drop_table("intake_runs")
