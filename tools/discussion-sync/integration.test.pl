use strict;
use warnings;
use utf8;
use Test::More;
use FindBin;
use File::Temp qw(tempdir);
use JSON::PP qw(decode_json encode_json);
use Fcntl qw(:flock);

my $dir = tempdir(CLEANUP => 1);
my $state_file = "$dir/state.json";
my $log_file = "$dir/requests.jsonl";
my $fake = "$dir/fake-api";
my $script = "$FindBin::Bin/sync.pl";
my $allowlist = decode_json(do { local $/; open my $fh, '<', "$FindBin::Bin/initial-approved-comments.json" or die $!; <$fh> });
my @gh = grep { $_->{sourceService} eq 'github' } @{$allowlist->{rows}};
my @gl = grep { $_->{sourceService} eq 'gitlab' } @{$allowlist->{rows}};
my $state = { gh => \@gh, gl => \@gl, posts => [], counters => {}, fail_after => 0 };
write_state($state);
write_file($fake, fake_cli());
chmod 0700, $fake;

sub write_file { my ($path,$text)=@_; open my $fh, '>:encoding(UTF-8)', $path or die $!; print {$fh} $text; close $fh }
sub write_state { my ($s)=@_; open my $fh, '>:raw', $state_file or die $!; print {$fh} JSON::PP->new->utf8->canonical->encode($s); close $fh }
sub read_state { open my $fh, '<:raw', $state_file or die $!; local $/; return decode_json(<$fh>) }
sub reset_state { my (%opts)=@_; $state={gh=>\@gh,gl=>\@gl,posts=>[],counters=>{},fail_after=>$opts{fail_after}//0}; write_state($state); unlink $log_file if -e $log_file }
sub run_sync {
    my (%opts)=@_;
    local %ENV = (%ENV,
      GH_CLI=>$opts{gh_cli}//$fake, GLAB_CLI=>$opts{glab_cli}//$fake, FAKE_STATE_FILE=>$state_file, FAKE_LOG_FILE=>$log_file,
      DISCUSSION_SYNC_LOCK_FILE=>$opts{lock_file}//"$dir/run.lock", DISCUSSION_SYNC_ENABLED=>$opts{enabled}//'',
      DISCUSSION_SYNC_EXPECTED_PLAN_SHA256=>$opts{expected}//'',
      DISCUSSION_SYNC_RECURRING=>'false');
    for my $key (qw(FAKE_FAIL_POST_AFTER FAKE_EDIT_SOURCE_ID FAKE_TARGET_EDIT_ON_RECHECK FAKE_ERROR_MODE FAKE_SLEEP_USER FAKE_ACTOR_MODE)) {
        if (exists $opts{$key}) { $ENV{$key}=$opts{$key} } else { delete $ENV{$key} }
    }
    my $out="$dir/out.txt"; my $err="$dir/err.txt";
    my @cmd=($^X,$script,($opts{apply}?'--apply':()));
    my $pid=fork(); die 'fork failed' unless defined $pid;
    if (!$pid) { open STDOUT,'>',$out; open STDERR,'>',$err; exec {$^X} @cmd; die 'exec failed' }
    waitpid($pid,0); my $status=$? >> 8;
    my $stdout=slurp($out); my $stderr=slurp($err);
    return ($status,$stdout,$stderr);
}
sub slurp { my ($path)=@_; open my $fh,'<:raw',$path or return ''; local $/; return <$fh>//'' }
sub do_dry_plan { my ($status,$out,$err)=run_sync(); is($status,0,'fixture dry-run succeeds'); return decode_json($out) }
sub request_rows { return [map { decode_json($_) } grep { length } split /\n/, slurp($log_file)] }
sub post_count { return scalar @{read_state()->{posts}} }

my ($dry_status,$dry_out,$dry_err)=run_sync();
is($dry_status,0,'actual sync.pl runs credential-free dry-run');
my $dry=decode_json($dry_out);
is($dry->{summary}{create_attributed_mirror},19,'dry-run keeps exactly the approved 19 source comments eligible');
is($dry->{readOnly},1,'default mode is read-only');
is(post_count(),0,'dry-run performs no API writes');
my @actor_lines = $dry_err =~ /^(DISCUSSION_SYNC_ACTORS .*)$/mg;
is(scalar @actor_lines,1,'successful identity lookups emit one actor evidence line');
my ($actor_json) = $actor_lines[0] =~ /^DISCUSSION_SYNC_ACTORS (\{.*\})$/;
my $actor_pair = decode_json($actor_json);
is_deeply($actor_pair,{github=>'sync-gh',gitlab=>'sync-gl'},'actor evidence contains only the authenticated username pair');
is_deeply([sort keys %$actor_pair],[qw(github gitlab)],'actor evidence has no unrelated response fields');
unlike($dry_err,qr/fixture-secret|token|headers|credential/i,'actor evidence discloses no credential or unrelated API fields');
my $logs=request_rows();
is(scalar(grep { $_->{host} ne ($_->{service} eq 'github'?'github.com':'gitlab.home.arpa') } @$logs),0,'every fake request uses the explicit expected host');

my ($wrong_status,$wrong_out,$wrong_err)=run_sync(apply=>1,enabled=>'true',expected=>'0'x64);
isnt($wrong_status,0,'wrong plan hash blocks apply');
is(post_count(),0,'wrong plan hash causes zero writes');
like($wrong_err,qr/does not match the reviewed plan hash/,'wrong-hash failure is actionable');

reset_state();
my $approved_plan=do_dry_plan();
my ($apply_status,$apply_out,$apply_err)=run_sync(apply=>1,enabled=>'true',expected=>$approved_plan->{planSha256});
is($apply_status,0,'fixture apply succeeds with exact fresh plan hash');
is(post_count(),19,'apply writes only the 19 allowlisted comment mirrors');
my $posted=read_state()->{posts};
ok((grep { $_->{body}=~/café/ && $_->{body}=~/🛰/ } @$posted)>0,'UTF-8 comment payload survives CLI input and API response');
is(scalar(grep { $_->{method} eq 'POST' && $_->{content_type} eq 'Content-Type: application/json' } @{request_rows()}),19,'every structured API write sends explicit JSON content type');
my $gl_rechecks=[grep { $_->{endpoint}=~m{^projects/27/issues/7/notes/71\d\d$} } @{request_rows()}];
ok(@$gl_rechecks>=5,'GitLab source notes are revalidated through object-scoped note endpoints');
is(scalar(grep { $_->{endpoint}=~m{^projects/27/notes/} } @{request_rows()}),0,'no invalid project-global note endpoint is used');

my $after=do_dry_plan();
is($after->{summary}{create_attributed_mirror}//0,0,'second inventory sees created mirrors and does not echo');
my ($again_status)=run_sync(apply=>1,enabled=>'true',expected=>$after->{planSha256});
is($again_status,0,'retry with refreshed plan succeeds');
is(post_count(),19,'retry does not duplicate existing mirrors');

reset_state(fail_after=>1);
my $partial_plan=do_dry_plan();
my ($partial_status,undef,$partial_err)=run_sync(apply=>1,enabled=>'true',expected=>$partial_plan->{planSha256},FAKE_FAIL_POST_AFTER=>1);
isnt($partial_status,0,'injected API failure stops partial apply');
is(post_count(),1,'one create before injected failure is durable');
my $partial_state=read_state();
$state={gh=>\@gh,gl=>\@gl,posts=>$partial_state->{posts},counters=>{},fail_after=>0}; write_state($state); unlink $log_file if -e $log_file;
my $resume_plan=do_dry_plan();
my ($resume_status)=run_sync(apply=>1,enabled=>'true',expected=>$resume_plan->{planSha256});
is($resume_status,0,'fresh plan permits a clean retry after an interrupted attempt');
is(post_count(),19,'resume has exactly one copy of each initial comment');
my %origins=map { $_->{body}=~/origin=([^ ]+)/ ? ($1=>1) : () } @{read_state()->{posts}};
is(scalar keys %origins,19,'all 19 durable markers are unique');

reset_state();
my $edit_plan=do_dry_plan();
my ($s,$o,$e)=run_sync(apply=>1,enabled=>'true',expected=>$edit_plan->{planSha256},FAKE_EDIT_SOURCE_ID=>$gh[0]{sourceCommentId});
isnt($s,0,'changed source is not written');
is(post_count(),0,'source edit scenario has zero writes');

reset_state();
my $target_plan=do_dry_plan();
my ($target_status,$target_out,$target_err)=run_sync(apply=>1,enabled=>'true',expected=>$target_plan->{planSha256},FAKE_TARGET_EDIT_ON_RECHECK=>1);
isnt($target_status,0,'concurrent target edit fails closed');
is(post_count(),0,'target conflict stops before any write');

reset_state();
my ($err_status,$err_out,$err_text)=run_sync(FAKE_ERROR_MODE=>'403');
isnt($err_status,0,'HTTP 403 is surfaced as a failure');
like($err_text,qr/HTTP 403.*verify the existing credential/,'403 gives sanitized access guidance');
like($err_text,qr/github GET user \(HTTP 403\)/,'403 identifies only the failing service and operation');
unlike($err_text.$err_out,qr/fixture-secret/,'permission errors never echo response secrets');
my ($unauth_status,$unauth_out,$unauth_text)=run_sync(FAKE_ERROR_MODE=>'401');
isnt($unauth_status,0,'HTTP 401 is surfaced as a failure');
like($unauth_text,qr/HTTP 401.*verify the existing credential/,'401 gives sanitized access guidance');
like($unauth_text,qr/github GET user \(HTTP 401\)/,'401 identifies only the failing service and operation');
unlike($unauth_text.$unauth_out,qr/fixture-secret/,'401 errors never echo response secrets');
for my $case (
    ['github-missing','github identity missing username fails closed'],
    ['github-malformed','github identity malformed username fails closed'],
    ['gitlab-missing','GitLab identity missing username fails closed'],
    ['gitlab-malformed','GitLab identity malformed username fails closed'],
    ['github-nonobject','non-object GitHub identity response fails closed'],
    ['gitlab-nonobject','non-object GitLab identity response fails closed'],
) {
    reset_state();
    my ($status,$out,$err)=run_sync(FAKE_ACTOR_MODE=>$case->[0]);
    isnt($status,0,$case->[1]);
    unlike($err,qr/^DISCUSSION_SYNC_ACTORS /m,'invalid actor pair emits no evidence line');
    is(post_count(),0,'invalid actor identity performs no metadata writes');
    unlike($err.$out,qr/fixture-secret|credential-path|private-header/i,'invalid identity diagnostics expose no fixture credential data');
}
my ($missing_cli_status,$missing_cli_out,$missing_cli_text)=run_sync(gh_cli=>"$dir/not-installed-gh");
isnt($missing_cli_status,0,'missing runner CLI is detected');
like($missing_cli_text,qr/API CLI unavailable for github GET user; install the required CLI on the protected runner/,'missing binary error names the CLI/service operation');
unlike($missing_cli_text.$missing_cli_out,qr/fixture-secret/,'CLI diagnostics disclose no response data');

reset_state();
my $first_out="$dir/concurrent-first.out"; my $first_err="$dir/concurrent-first.err";
my $first_pid;
{
    local %ENV=(%ENV,GH_CLI=>$fake,GLAB_CLI=>$fake,FAKE_STATE_FILE=>$state_file,FAKE_LOG_FILE=>$log_file,
      DISCUSSION_SYNC_LOCK_FILE=>"$dir/concurrent.lock",FAKE_SLEEP_USER=>1.5);
    $first_pid=fork(); die 'fork failed' unless defined $first_pid;
    if (!$first_pid) { open STDOUT,'>',$first_out; open STDERR,'>',$first_err; exec {$^X} $^X,$script; die 'exec failed' }
}
select undef,undef,undef,0.2;
my ($concurrent_status,$concurrent_out,$concurrent_err)=run_sync(lock_file=>"$dir/concurrent.lock");
isnt($concurrent_status,0,'overlapping process is excluded by the shared lock');
like($concurrent_err,qr/another local discussion-sync run is active/,'lock rejection is explicit and bounded');
waitpid($first_pid,0); is($? >> 8,0,'first serialized dry-run completes successfully');

done_testing();

sub fake_cli {
return <<'FAKE';
#!/usr/bin/env perl
use strict; use warnings; use JSON::PP qw(decode_json); use utf8;
my @args=@ARGV; shift @args if @args && $args[0] eq 'api';
my $endpoint=shift @args // ''; my $host=''; my $method='GET'; my $input; my $content_type='';
for (my $i=0;$i<@args;$i++) { if ($args[$i] eq '--hostname') {$host=$args[++$i]//''} elsif ($args[$i] eq '-X') {$method=$args[++$i]//''} elsif ($args[$i] eq '--input') {$input=$args[++$i]} elsif ($args[$i] eq '-H') {$content_type=$args[++$i]//''} }
my $service=$host eq 'github.com'?'github':$host eq 'gitlab.home.arpa'?'gitlab':'unknown';
my $state_path=$ENV{FAKE_STATE_FILE}; open my $sf,'<:raw',$state_path or die 'state'; local $/; my $state=decode_json(<$sf>); close $sf;
sub logrow { my ($r)=@_; open my $lf,'>>:raw',$ENV{FAKE_LOG_FILE} or die 'log'; print {$lf} JSON::PP->new->utf8->encode($r),"\n"; close $lf }
logrow({service=>$service,host=>$host,endpoint=>$endpoint,method=>$method,content_type=>$content_type});
if (($ENV{FAKE_ERROR_MODE}//'') =~ /\A(401|403)\z/ && $endpoint eq 'user') { print STDERR "HTTP $1 token=fixture-secret"; exit 1 }
if (($ENV{FAKE_SLEEP_USER}//'') ne '' && $endpoint eq 'user') { select undef,undef,undef,$ENV{FAKE_SLEEP_USER} }
if ($host ne ($service eq 'github'?'github.com':'gitlab.home.arpa')) { print STDERR 'invalid host'; exit 1 }
if ($method ne 'GET' && $content_type ne 'Content-Type: application/json') { print STDERR 'HTTP 415 missing content type'; exit 1 }
if ($endpoint eq 'user') {
  my $mode=$ENV{FAKE_ACTOR_MODE}//'';
  my $response;
  if ($service eq 'github') {
    $response = $mode eq 'github-nonobject' ? ['sync-gh'] : {login=>'sync-gh',token=>'fixture-secret',headers=>{'Authorization'=>'private-header'},credential_path=>'/fixture/credential-path'};
    delete $response->{login} if ref($response) eq 'HASH' && $mode eq 'github-missing';
    $response->{login}={name=>'sync-gh'} if ref($response) eq 'HASH' && $mode eq 'github-malformed';
  } else {
    $response = $mode eq 'gitlab-nonobject' ? ['sync-gl'] : {username=>'sync-gl',token=>'fixture-secret',headers=>{'Authorization'=>'private-header'},credential_path=>'/fixture/credential-path'};
    delete $response->{username} if ref($response) eq 'HASH' && $mode eq 'gitlab-missing';
    $response->{username}={name=>'sync-gl'} if ref($response) eq 'HASH' && $mode eq 'gitlab-malformed';
  }
  print JSON::PP->new->utf8->encode($response); exit 0
}
my $payload;
if ($input) { open my $pf,'<:raw',$input or die 'input'; local $/; $payload=decode_json(<$pf>); close $pf }
if ($method eq 'POST') {
  if ($ENV{FAKE_FAIL_POST_AFTER} && @{$state->{posts}}>=$ENV{FAKE_FAIL_POST_AFTER}) { print STDERR 'HTTP 500 token=fixture-secret'; exit 1 }
  my $id=900000+@{$state->{posts}}; my $path=$endpoint; $path =~ s/\?.*//;
  my $row={service=>$service,path=>$path,id=>$id,body=>$payload->{body},method=>$method,content_type=>$content_type,user=>{login=>'sync-gh'}};
  $row->{author}={username=>'sync-gl'} if $service eq 'gitlab';
  push @{$state->{posts}},$row; open my $out,'>:raw',$state_path; print {$out} JSON::PP->new->utf8->canonical->encode($state); close $out;
  print JSON::PP->new->utf8->encode($row); exit 0;
}
my $response;
if ($service eq 'github' && $endpoint =~ m{^repos/dinered/codexpro/(issues|pulls)/(\d+)$}) {
  my ($kind,$num)=($1,$2); $response={html_url=>"https://github.com/dinered/codexpro/$kind/$num"};
} elsif ($service eq 'gitlab' && $endpoint =~ m{^projects/27/(issues|merge_requests)/(\d+)$}) {
  my ($kind,$num)=($1,$2); $response={web_url=>"http://gitlab.home.arpa/ai-company/codexpro/-/$kind/$num"};
} elsif ($service eq 'github' && $endpoint =~ m{^repos/dinered/codexpro/issues/comments/(\d+)$}) {
  my $id=$1; my ($source)=grep { $_->{sourceCommentId}==$id } @{$state->{gh}};
  $response={id=>$id,body=>'fixture body '.$id.' café 🛰',created_at=>'2026-10-25T01:00:00Z',updated_at=>'2026-10-25T01:00:00Z',html_url=>"https://github.com/dinered/codexpro/issues/$source->{sourceObjectId}#comment-$id",user=>{login=>'original-author'}} if $source;
} elsif ($service eq 'gitlab' && $endpoint =~ m{^projects/27/(issues|merge_requests)/(\d+)/notes/(\d+)$}) {
  my ($kind,$obj,$id)=($1,$2,$3); my ($source)=grep { $_->{sourceCommentId}==$id && $_->{sourceObjectId}==$obj } @{$state->{gl}};
  $response={id=>$id,body=>'fixture body '.$id.' café 🛰',created_at=>'2026-10-25T01:00:00Z',updated_at=>'2026-10-25T01:00:00Z',web_url=>"http://gitlab.home.arpa/ai-company/codexpro/-/issues/$obj#note_$id",author=>{username=>'original-author'}} if $source;
} elsif ($service eq 'github' && $endpoint =~ m{^repos/dinered/codexpro/issues/(\d+)/comments}) {
  my $obj=$1; my @items=map {{id=>$_->{sourceCommentId},body=>'fixture body '. $_->{sourceCommentId}.' café 🛰',created_at=>'2026-10-25T01:00:00Z',updated_at=>'2026-10-25T01:00:00Z',html_url=>"https://github.com/dinered/codexpro/issues/$obj#comment-$_->{sourceCommentId}",user=>{login=>'original-author'}}} grep { $_->{sourceObjectId}==$obj && $_->{sourceService} eq 'github' } @{$state->{gh}};
  my @posts=map {{id=>$_->{id},body=>$_->{body},user=>$_->{user}}} grep { $_->{service} eq 'github' && $_->{path} eq "repos/dinered/codexpro/issues/$obj/comments" } @{$state->{posts}};
  push @items,@posts; $response=endpoint_page(\@items,$endpoint);
} elsif ($service eq 'gitlab' && $endpoint =~ m{^projects/27/(issues|merge_requests)/(\d+)/notes(?:\?|$)}) {
  my ($kind,$obj)=($1,$2); my @items;
  if ($kind eq 'issues' && $obj==7) { @items=map {{id=>$_->{sourceCommentId},body=>'fixture body '. $_->{sourceCommentId}.' café 🛰',created_at=>'2026-10-25T01:00:00Z',updated_at=>'2026-10-25T01:00:00Z',web_url=>"http://gitlab.home.arpa/ai-company/codexpro/-/issues/7#note_$_->{sourceCommentId}",author=>{username=>'original-author'}}} @{$state->{gl}} }
  my $path="projects/27/$kind/$obj/notes"; my @posts=map {{id=>$_->{id},body=>$_->{body},author=>$_->{author}}} grep { $_->{service} eq 'gitlab' && $_->{path} eq $path } @{$state->{posts}};
  push @items,@posts;
  if (($ENV{FAKE_TARGET_EDIT_ON_RECHECK}//'') && scalar(grep { $_->{endpoint}=~m{^\Q$path\E(?:\?|$)} } @{read_logs()})>=2) { push @items,{id=>899999,body=>'edited <!-- codexpro-discussion-sync:v1 broken -->',author=>{username=>'sync-gl'}} }
  if (($ENV{FAKE_EDIT_SOURCE_ID}//'') && $endpoint =~ m{/notes/$ENV{FAKE_EDIT_SOURCE_ID}$}) { for (@items) { $_->{body}.=' concurrent-source-edit' if $_->{id}==$ENV{FAKE_EDIT_SOURCE_ID} } }
  $response=endpoint_page(\@items,$endpoint);
} else { print STDERR 'HTTP 404'; exit 1 }
if (ref($response) eq 'HASH' && ($ENV{FAKE_EDIT_SOURCE_ID}//'') && ($response->{id}//'') eq $ENV{FAKE_EDIT_SOURCE_ID}) { $response->{body}.=' concurrent-source-edit' }
if (defined $response) { print JSON::PP->new->utf8->encode($response); exit 0 }
print JSON::PP->new->utf8->encode([]); exit 0;
sub endpoint_page { my ($items,$path)=@_; my ($page)=$path =~ /[?&]page=(\d+)/; return $page && $page>1 ? [] : $items }
sub read_logs { open my $lf,'<:raw',$ENV{FAKE_LOG_FILE} or return []; my @rows=map { decode_json($_) } grep { length } <$lf>; close $lf; return \@rows }
FAKE
}
