use strict;
use warnings;
use Test::More tests => 3;
use File::Temp qw(tempdir);

my ($glab, $host) = @ARGV;
die "usage: $0 /path/to/glab hostname\n" unless defined $host;
die "pinned glab binary is unavailable\n" unless -x $glab;
die "invalid GitLab hostname\n" unless $host =~ /\A[A-Za-z0-9.-]+\z/;

my $dir = tempdir(CLEANUP => 1);
my $home = "$dir/home";
my $config = "$dir/config";
my $system_config = "$dir/system-config";
mkdir $_ for ($home, $config, $system_config);
my $config_file = "$config/config.yml";
open my $cfg, '>', $config_file or die "cannot write isolated glab config\n";
print {$cfg} "check_update: false\nhosts:\n  $host:\n    api_protocol: http\n";
close $cfg or die "cannot close isolated glab config\n";
chmod 0600, $config_file;

my $stdout = "$dir/glab.stdout";
my $stderr = "$dir/glab.stderr";
my $pid = fork();
die "cannot start pinned glab\n" unless defined $pid;
if (!$pid) {
    $ENV{HOME} = $home;
    $ENV{GLAB_CONFIG_DIR} = $config;
    $ENV{XDG_CONFIG_HOME} = $config;
    $ENV{XDG_CONFIG_DIRS} = $system_config;
    $ENV{GLAB_SEND_TELEMETRY} = 'false';
    delete @ENV{qw(GITLAB_TOKEN GITLAB_ACCESS_TOKEN OAUTH_TOKEN CI_JOB_TOKEN GH_TOKEN GITHUB_TOKEN GLAB_ENABLE_CI_AUTOLOGIN)};
    open STDOUT, '>', $stdout or exit 126;
    open STDERR, '>', $stderr or exit 126;
    exec {$glab} $glab, 'config', 'get', 'api_protocol', '--host', $host or exit 127;
}

waitpid($pid, 0);
my $status = $? >> 8;
is($status, 0, 'pinned glab reads the isolated host configuration without API credentials');
open my $out, '<', $stdout or die "cannot read isolated glab output\n";
my $output = <$out> // '';
close $out;
is($output, "http\n", 'pinned glab resolves the GitLab API scheme to HTTP');
open my $check, '<', $stderr or die "cannot read isolated glab stderr\n";
my $error = <$check> // '';
close $check;
is($error, '', 'protocol resolution makes no API request and emits no telemetry/error');
