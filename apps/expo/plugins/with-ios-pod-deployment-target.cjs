// @ts-check
const { createRunOncePlugin, withPodfile } = require('expo/config-plugins');

// Xcode 27.2 refuses to build a target whose IPHONEOS_DEPLOYMENT_TARGET is
// below 15.0; older Xcode only warned. Pod targets keep the minimum from their
// own podspec (SDWebImage 9.0, Sentry 11.0, ReachabilitySwift 12.0,
// RNSVGFilters 12.4), so a stock simulator or store build dies in the Pods
// project. This raises every pod target below the app's own deployment target
// (the Podfile `platform :ios`: Expo SDK 56's 16.4 default, or `ios.deploymentTarget`)
// up to it. Same fix as ForgeGraph's FORGE-356 plugin; FORGE-442 puts it in
// the template so new apps start with it.
const BEGIN = '# @generated begin gmacko-pod-deployment-target';
const END = '# @generated end gmacko-pod-deployment-target';
const ANCHOR = /^(\s*)react_native_post_install\(/m;

const FLOOR = [
  BEGIN,
  '    app_ios_target = installer.aggregate_targets',
  '      .map { |t| t.platform.deployment_target }',
  '      .compact',
  '      .max',
  '    if app_ios_target',
  '      installer.pods_project.targets.each do |target|',
  '        target.build_configurations.each do |build_config|',
  "          current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']",
  '          next if current.nil? || current.to_s.empty?',
  '          next unless Pod::Version.new(current.to_s) < app_ios_target',
  "          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_ios_target.to_s",
  '        end',
  '      end',
  '    end',
  END,
].join('\n');

/**
 * Insert the pod deployment-target floor into a Podfile's post_install,
 * before react_native_post_install. Idempotent.
 * @param {string} podfile
 * @returns {string}
 */
function addPodDeploymentTargetFloor(podfile) {
  if (podfile.includes(BEGIN)) return podfile;
  const match = ANCHOR.exec(podfile);
  if (!match) {
    throw new Error(
      'with-ios-pod-deployment-target: no react_native_post_install( in the Podfile. ' +
        'The Expo Podfile template changed; update apps/expo/plugins/with-ios-pod-deployment-target.cjs.',
    );
  }
  return `${podfile.slice(0, match.index)}${FLOOR}\n${podfile.slice(match.index)}`;
}

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withIosPodDeploymentTarget = (config) =>
  withPodfile(config, (podConfig) => {
    podConfig.modResults.contents = addPodDeploymentTargetFloor(podConfig.modResults.contents);
    return podConfig;
  });

module.exports = createRunOncePlugin(
  withIosPodDeploymentTarget,
  'with-ios-pod-deployment-target',
  '1.0.0',
);
module.exports.addPodDeploymentTargetFloor = addPodDeploymentTargetFloor;
