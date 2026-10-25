#!/usr/bin/env perl
use strict;
use warnings;
use FindBin;
use lib $FindBin::Bin;
use JSON::PP qw(decode_json);
use File::Temp qw(tempdir tempfile);
use Digest::SHA qw(sha256_hex);
use Fcntl qw(:flock);
use POSIX qw(:sys_wait_h);
use DiscussionSync qw(origin_id body_hash render_mirror classify_comment plan_hash bounded_pages);

my $GH = $ENV{GH_CLI} // 'gh';
my $GL = $ENV{GLAB_CLI} // 'glab';
my $GH_HOST = 'github.com';
my $GL_HOST = 'gitlab.home.arpa';
my $GH_PROJECT = 'github.com/dinered/codexpro';
my $GL_PROJECT = 'gitlab.home.arpa/ai-company/codexpro';
my $MAX_PAGES = 100;
my $TIMEOUT = 20;
my $MAX_OUTPUT = 20 * 1024 * 1024;
my $TEMP = tempdir('codexpro-discussion-sync-XXXXXX', TMPDIR => 1, CLEANUP => 1);
my $approved_file = "$FindBin::Bin/initial-approved-comments.json";
my $approved_data = decode_json(do { local $/; open my $fh, '<', $approved_file or die "approved initial comment scope unavailable\n"; <$fh> });
my %approved_origin = map { $_->{originId} => 1 } @{$approved_data->{rows}};
my $APPLY = 0;
my $EXPECTED = $ENV{DISCUSSION_SYNC_EXPECTED_PLAN_SHA256} // '';
my $RECURRING = ($ENV{DISCUSSION_SYNC_RECURRING} // '') eq 'true';
for my $arg (@ARGV) { $APPLY = 1 if $arg eq '--apply'; die "usage: sync.pl [--apply]\n" if $arg ne '--apply' }
if (defined $ENV{GITHUB_SYNC_TOKEN} && length $ENV{GITHUB_SYNC_TOKEN}) { $ENV{GH_TOKEN} = $ENV{GITHUB_SYNC_TOKEN} }
if (defined $ENV{GITLAB_SYNC_TOKEN} && length $ENV{GITLAB_SYNC_TOKEN}) { $ENV{GITLAB_TOKEN} = $ENV{GITLAB_SYNC_TOKEN} }
die "discussion sync apply requires DISCUSSION_SYNC_ENABLED=true\n" if $APPLY && ($ENV{DISCUSSION_SYNC_ENABLED} // '') ne 'true';
die "initial discussion sync apply requires an expected SHA-256 plan hash\n" if $APPLY && !$RECURRING && $EXPECTED !~ /\A[a-f0-9]{64}\z/;
die "recurring discussion sync apply requires DISCUSSION_SYNC_RECURRING_CONFIRMED=true\n"
    if $APPLY && $RECURRING && ($ENV{DISCUSSION_SYNC_RECURRING_CONFIRMED} // '') ne 'true';
die "expected plan hash must be lowercase SHA-256\n" if length($EXPECTED) && $EXPECTED !~ /\A[a-f0-9]{64}\z/;
my $lock_path = $ENV{DISCUSSION_SYNC_LOCK_FILE} // '/tmp/codexpro-discussion-sync.lock';
open my $lock, '>>', $lock_path or die "cannot open discussion-sync lock\n";
flock($lock, LOCK_EX | LOCK_NB) or die "another local discussion-sync run is active\n";

sub safe_cli {
    my ($service, $method, $endpoint, $payload) = @_;
    my $bin = $service eq 'github' ? $GH : $GL;
    my $host = $service eq 'github' ? $GH_HOST : $GL_HOST;
    my @cmd = $service eq 'github'
        ? ($bin, 'api', $endpoint, '--hostname', $host)
        : ($bin, 'api', $endpoint, '--hostname', $host);
    if ($method ne 'GET') {
        push @cmd, '-X', $method;
        if (defined $payload) {
            push @cmd, '-H', 'Content-Type: application/json';
            my ($fh, $path) = tempfile('request-XXXXXX', DIR => $TEMP, UNLINK => 0);
            chmod 0600, $path;
            print {$fh} JSON::PP->new->canonical->utf8->encode($payload);
            close $fh;
            push @cmd, '--input', $path;
        }
    }
    my ($outfh, $outpath) = tempfile('response-XXXXXX', DIR => $TEMP, UNLINK => 0);
    my ($errfh, $errpath) = tempfile('error-XXXXXX', DIR => $TEMP, UNLINK => 0);
    close $outfh; close $errfh;
    my $pid = fork();
    die "cannot start API command\n" unless defined $pid;
    if ($pid == 0) {
        open STDIN, '<', '/dev/null' or exit 126;
        open STDOUT, '>', $outpath or exit 126;
        open STDERR, '>', $errpath or exit 126;
        exec {$bin} @cmd or do {
            syswrite STDERR, "DISCUSSION_SYNC_EXEC_FAILED\n";
            POSIX::_exit(127);
        };
    }
    my $timed_out = 0;
    local $SIG{ALRM} = sub { $timed_out = 1; kill 'TERM', $pid; select undef, undef, undef, 0.25; kill 'KILL', $pid; waitpid($pid, 0); die "API request timed out\n" };
    alarm $TIMEOUT;
    waitpid($pid, 0);
    my $exit_code = $? >> 8;
    alarm 0;
    if ($exit_code != 0 || $timed_out) {
        if (open my $err, '<', $errpath) {
            my $message = ''; read($err, $message, 4096); close $err;
            my ($status) = $message =~ /\b(401|403)\b/;
            my $context = "$service $method $endpoint";
            die "API request failed for $context (HTTP $status); verify the existing credential's required access\n" if $status;
            die "API CLI unavailable for $context; install the required CLI on the protected runner\n"
                if $exit_code == 127 && $message =~ /DISCUSSION_SYNC_EXEC_FAILED/;
        }
        die "API request failed for $service $method $endpoint\n";
    }
    die "API response exceeded size limit\n" if -s $outpath > $MAX_OUTPUT;
    open my $read, '<:raw', $outpath or die "API response unavailable\n";
    local $/; my $text = <$read>; close $read;
    my $decoded = eval { decode_json($text // '') };
    die "API response from $service $endpoint was not valid JSON\n" if $@;
    return $decoded;
}
sub get { return safe_cli($_[0], 'GET', $_[1], undef) }
sub post { return safe_cli($_[0], 'POST', $_[1], $_[2]) }
sub pages {
    my ($service, $path) = @_;
    return bounded_pages(sub {
        my ($page) = @_;
        my $sep = index($path, '?') >= 0 ? '&' : '?';
        my $batch = get($service, "$path${sep}per_page=100&page=$page");
        return $batch;
    }, $MAX_PAGES);
}
sub file_hash {
    my ($path) = @_;
    open my $fh, '<:raw', $path or die "plan input unavailable\n";
    my $sha = Digest::SHA->new(256); $sha->addfile($fh); close $fh;
    return $sha->hexdigest;
}
sub api_actor {
    my ($service) = @_;
    my $user = get($service, 'user');
    die "could not verify authenticated API actor\n" unless ref($user) eq 'HASH';
    my $name = $service eq 'github' ? $user->{login} : $user->{username};
    die "could not verify authenticated API actor\n"
        unless defined $name && !ref($name) && $name =~ /\A[A-Za-z0-9_.-]+\z/;
    return $name;
}
sub actor_for { my ($service, $record) = @_; return $service eq 'github' ? ($record->{user}{login} // '') : ($record->{author}{username} // '') }
sub url_for { my ($service, $record, $parent, $id) = @_; return $record->{html_url} // $record->{web_url} // ($service eq 'gitlab' ? "$parent#note_$id" : '') }
sub has_attachment { my ($body) = @_; return $body =~ /(?:!\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s)]+(?:\.png|\.jpe?g|\.gif|\.webp|\.mp4|\.mov)(?:\?[^\s)]*)?)/i }
sub project_path { my ($kind, $iid) = @_; return $kind eq 'issue' ? "issues/$iid" : "merge_requests/$iid" }
sub note_path { my ($kind, $iid) = @_; return 'projects/27/' . project_path($kind, $iid) . '/notes?activity_filter=only_comments' }
sub comments_path { my ($number) = @_; return "repos/dinered/codexpro/issues/$number/comments" }
sub source_revalidate_endpoint {
    my ($service, $kind, $object, $comment) = @_;
    return "repos/dinered/codexpro/issues/comments/$comment" if $service eq 'github';
    my $gitlab_kind = $kind eq 'gitlab-issue' ? 'issue' : 'merge_request';
    return 'projects/27/' . project_path($gitlab_kind, $object) . "/notes/$comment";
}
sub comment_record {
    my (%arg) = @_;
    my $body = defined $arg{item}{body} ? $arg{item}{body} : '';
    my $id = $arg{item}{id};
    my $origin = origin_id($arg{source_service}, $arg{source_kind}, $arg{source_id}, $id,
        $arg{source_service} eq 'github' ? $GH_PROJECT : $GL_PROJECT);
    my $sha = body_hash($body);
    my $source_url = url_for($arg{source_service}, $arg{item}, $arg{source_url}, $id);
    my $current = classify_comment(origin => $origin, source_body => $body,
        source_api_actor => actor_for($arg{source_service}, $arg{item}), source_sync_actor => $arg{source_actor},
        target_comments => [map { +{ body => $_->{body} // '', api_actor => actor_for($arg{target_service}, $_) } } @{$arg{target_items}}],
        target_sync_actor => $arg{target_actor}, source_hash => $sha);
    my $action = $current;
    $action = 'manual_attachment_review' if $current eq 'create' && has_attachment($body);
    $action = 'create_attributed_mirror' if $current eq 'create' && !has_attachment($body);
    $action = 'create_attributed_revision' if $current eq 'source_revision' && !has_attachment($body);
    $action = 'manual_attachment_review' if $current eq 'source_revision' && has_attachment($body);
    $action = 'unapproved_new_comment_review' if !$RECURRING && ($action eq 'create_attributed_mirror' || $action eq 'create_attributed_revision') && !$approved_origin{$origin};
    return { action => $action, sourceService => $arg{source_service}, targetService => $arg{target_service},
        sourceObjectKind => $arg{source_kind}, sourceObjectId => $arg{source_id}, sourceCommentId => $id,
        originId => $origin, sourceBodySha256 => $sha, author => actor_for($arg{source_service}, $arg{item}),
        createdAt => $arg{item}{created_at}, updatedAt => $arg{item}{updated_at}, sourceUrl => $source_url,
        targetObjectUrl => $arg{target_object_url}, attachmentCount => has_attachment($body) ? 1 : 0,
        _body => $body, _sourceService => $arg{source_service}, _sourceEndpoint => $arg{source_endpoint},
        _sourceRevalidateEndpoint => source_revalidate_endpoint($arg{source_service}, $arg{source_kind}, $arg{source_id}, $id),
        _targetEndpoint => $arg{target_endpoint}, _targetKind => $arg{target_kind}, _targetId => $arg{target_id},
        _sourceRecord => $arg{item}, _targetItems => $arg{target_items} };
}

my $mapping = decode_json(do { local $/; open my $fh, '<', "$FindBin::Bin/mappings.json" or die "mapping unavailable\n"; <$fh> });
my $gh_actor = api_actor('github');
my $gl_actor = api_actor('gitlab');
print STDERR 'DISCUSSION_SYNC_ACTORS ' . JSON::PP->new->canonical->encode({ github => $gh_actor, gitlab => $gl_actor }) . "\n";
my @rows;
my @directions;
sub add_direction {
    my (%arg) = @_;
    my $target_items = $arg{target_items};
    for my $item (@{$arg{source_items}}) {
        push @rows, comment_record(%arg, item => $item, target_items => $target_items);
    }
}
sub add_issue_pair {
    my ($ghn, $gliid, $is_reverse) = @_;
    my $gh_obj = get('github', "repos/dinered/codexpro/issues/$ghn");
    my $gl_obj = get('gitlab', "projects/27/issues/$gliid");
    my $gh_comments = pages('github', "repos/dinered/codexpro/issues/$ghn/comments");
    my $gl_notes = [grep { !$_->{system} && !$_->{position} } @{pages('gitlab', "projects/27/issues/$gliid/notes?activity_filter=only_comments")}];
    my ($gh_to_gl_source, $gl_to_gh_source) = $is_reverse ? ($gh_comments, $gl_notes) : ($gh_comments, $gl_notes);
    my $gh_url = $gh_obj->{html_url} // "https://github.com/dinered/codexpro/issues/$ghn";
    my $gl_url = $gl_obj->{web_url} // "http://gitlab.home.arpa/ai-company/codexpro/-/issues/$gliid";
    push @directions,
      { source_service=>'github',target_service=>'gitlab',source_kind=>'github-issue',source_id=>$ghn,source_url=>$gh_url,source_endpoint=>"repos/dinered/codexpro/issues/$ghn/comments",source_items=>$gh_to_gl_source,source_actor=>$gh_actor,target_actor=>$gl_actor,target_object_url=>$gl_url,target_items=>$gl_notes,target_endpoint=>"projects/27/issues/$gliid/notes",target_kind=>'issue',target_id=>$gliid },
      { source_service=>'gitlab',target_service=>'github',source_kind=>'gitlab-issue',source_id=>$gliid,source_url=>$gl_url,source_endpoint=>"projects/27/issues/$gliid/notes?activity_filter=only_comments",source_items=>$gl_to_gh_source,source_actor=>$gl_actor,target_actor=>$gh_actor,target_object_url=>$gh_url,target_items=>$gh_comments,target_endpoint=>"repos/dinered/codexpro/issues/$ghn/comments",target_kind=>'issue',target_id=>$ghn };
}
for my $pair (@{$mapping->{issues}}) { add_issue_pair($pair->{githubNumber}, $pair->{gitlabIid}, 0) }
for my $pair (@{$mapping->{pullRequests}}) {
    my ($ghn,$gliid)=@$pair{qw(githubNumber gitlabIid)};
    my $gh_obj=get('github',"repos/dinered/codexpro/pulls/$ghn"); my $gl_obj=get('gitlab',"projects/27/merge_requests/$gliid");
    my $gh_comments=pages('github',"repos/dinered/codexpro/issues/$ghn/comments");
    my $gl_notes=[grep { !$_->{system} && !$_->{position} } @{pages('gitlab',"projects/27/merge_requests/$gliid/notes?activity_filter=only_comments")}];
    my $gh_url=$gh_obj->{html_url}; my $gl_url=$gl_obj->{web_url};
    push @directions,
      { source_service=>'github',target_service=>'gitlab',source_kind=>'github-pr',source_id=>$ghn,source_url=>$gh_url,source_endpoint=>"repos/dinered/codexpro/issues/$ghn/comments",source_items=>$gh_comments,source_actor=>$gh_actor,target_actor=>$gl_actor,target_object_url=>$gl_url,target_items=>$gl_notes,target_endpoint=>"projects/27/merge_requests/$gliid/notes",target_kind=>'merge_request',target_id=>$gliid },
      { source_service=>'gitlab',target_service=>'github',source_kind=>'gitlab-mr',source_id=>$gliid,source_url=>$gl_url,source_endpoint=>"projects/27/merge_requests/$gliid/notes?activity_filter=only_comments",source_items=>$gl_notes,source_actor=>$gl_actor,target_actor=>$gh_actor,target_object_url=>$gh_url,target_items=>$gh_comments,target_endpoint=>"repos/dinered/codexpro/issues/$ghn/comments",target_kind=>'issue',target_id=>$ghn };
}
add_issue_pair($mapping->{gitlabOnlyIssue}{githubNumber}, $mapping->{gitlabOnlyIssue}{gitlabIid}, 1);
for my $direction (@directions) { add_direction(%$direction) }

my $counterpart_file = "$FindBin::Bin/counterpart-proposals.json";
my $counterparts = decode_json(do { local $/; open my $fh, '<', $counterpart_file or die "counterpart proposals unavailable\n"; <$fh> });
my $status_file = "$FindBin::Bin/status-copy-proposals.json";
my $status_proposals = decode_json(do { local $/; open my $fh, '<', $status_file or die "status-copy proposals unavailable\n"; <$fh> });
my $discussion_file = "$FindBin::Bin/unmapped-discussion-proposals.json";
my $discussion_proposals = decode_json(do { local $/; open my $fh, '<', $discussion_file or die "unmapped discussion proposals unavailable\n"; <$fh> });
my @safe_rows;
for my $row (@rows) { my %safe = %$row; delete @safe{grep { /^_/ } keys %safe}; push @safe_rows, \%safe }
@safe_rows = sort { join("\0",@$a{qw(action sourceService sourceObjectKind sourceObjectId sourceCommentId)}) cmp join("\0",@$b{qw(action sourceService sourceObjectKind sourceObjectId sourceCommentId)}) } @safe_rows;
my @proposal_rows = map { +{ action=>'unmapped_entity_counterpart_review', %$_ } } @{$counterparts->{rows}};
my @status_rows = map { +{ action=>'status_copy_close_candidate', %$_ } } @{$status_proposals->{rows}};
my @discussion_rows = @{$discussion_proposals->{rows}};
my $plan = { schemaVersion=>1, readOnly=>!$APPLY, githubRepository=>'dinered/codexpro', gitlabProject=>'ai-company/codexpro',
    implementationSha256=>file_hash("$FindBin::Bin/sync.pl"), mappingSha256=>file_hash("$FindBin::Bin/mappings.json"), approvedCommentsSha256=>file_hash($approved_file),
    counterpartProposalsSha256=>file_hash($counterpart_file), statusProposalsSha256=>file_hash($status_file),
    unmappedDiscussionSnapshotSha256=>file_hash($discussion_file),
    discussionSyncModuleSha256=>file_hash("$FindBin::Bin/DiscussionSync.pm"),
    summary=>{}, rows=>[ @safe_rows, @proposal_rows, @status_rows, @discussion_rows ] };
for my $row (@safe_rows,@proposal_rows,@status_rows,@discussion_rows) { $plan->{summary}{$row->{action}}++ }
my $hash = plan_hash($plan);
my %hash_input = %$plan; $hash_input{readOnly} = 1;
$hash = plan_hash(\%hash_input);
die "live source plan does not match the reviewed plan hash\n" if $APPLY && length($EXPECTED) && $EXPECTED ne $hash;
my $json = JSON::PP->new->canonical->utf8->pretty->encode({ %$plan, planSha256=>$hash });
if (!$APPLY) { print $json; exit 0 }

my $written = 0;
for my $row (@rows) {
    next unless $row->{action} eq 'create_attributed_mirror' || $row->{action} eq 'create_attributed_revision';
    # Re-read the exact source item immediately before writing; any edit after plan freeze aborts.
    my $current = get($row->{_sourceService}, $row->{_sourceRevalidateEndpoint});
    die "source item changed or disappeared since plan\n" unless ref($current) eq 'HASH' && "$current->{id}" eq "$row->{sourceCommentId}" && body_hash($current->{body} // '') eq $row->{sourceBodySha256};
    my $target_service = $row->{targetService};
    my $target_list_endpoint = $target_service eq 'gitlab'
        ? 'projects/27/' . project_path($row->{_targetKind}, $row->{_targetId}) . '/notes?activity_filter=only_comments'
        : $row->{_targetEndpoint};
    my $target_items = pages($target_service, $target_list_endpoint);
    if ($target_service eq 'gitlab') {
        $target_items = [grep { !$_->{system} && !$_->{position} } @$target_items];
    }
    my $recheck = classify_comment(origin=>$row->{originId},source_body=>$current->{body}//'',source_api_actor=>actor_for($row->{_sourceService},$current),source_sync_actor=>$row->{_sourceService} eq 'github'?$gh_actor:$gl_actor,
       target_comments=>[map { +{ body=>$_->{body}//'',api_actor=>actor_for($target_service,$_) } } @$target_items],target_sync_actor=>$target_service eq 'github'?$gh_actor:$gl_actor,source_hash=>$row->{sourceBodySha256});
    next if $recheck eq 'already_mirrored';
    die "source or target state changed after plan; no further writes attempted\n" unless $recheck eq 'create' || $recheck eq 'source_revision';
    my $mirror = render_mirror($row->{originId},$current->{body}//'', $target_service eq 'github'?$gh_actor:$gl_actor,
       $row->{_sourceService},$row->{sourceUrl},$row->{author},$row->{createdAt});
    my $payload = { body => $mirror };
    my $response = post($target_service,$row->{_targetEndpoint},$payload);
    die "target API did not return a created mirror ID\n" unless ref($response) eq 'HASH' && $response->{id};
    die "created mirror could not be verified\n" unless classify_comment(origin=>$row->{originId},source_body=>$current->{body}//'',source_api_actor=>actor_for($row->{_sourceService},$current),source_sync_actor=>$row->{_sourceService} eq 'github'?$gh_actor:$gl_actor,
       target_comments=>[{body=>$response->{body}//'',api_actor=>actor_for($target_service,$response)}],target_sync_actor=>$target_service eq 'github'?$gh_actor:$gl_actor,source_hash=>$row->{sourceBodySha256}) eq 'already_mirrored';
    $written++;
}
print JSON::PP->new->canonical->encode({ applied=>1, createdOrRevised=>$written, planSha256=>$hash }),"\n";
