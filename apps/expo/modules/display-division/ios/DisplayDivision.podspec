Pod::Spec.new do |s|
  s.name = 'DisplayDivision'
  s.version = '1.0.0'
  s.summary = 'Report the fold reserved by UIKit in the Dataflare workspace.'
  s.author = 'Dataflare'
  s.homepage = 'https://dataflare.dev'
  s.license = 'MIT'
  s.source = { :git => 'https://git.forgegraf.com/gmackie/glass-analytics.git' }
  s.platform = :ios, '16.4'
  s.static_framework = true
  s.source_files = '*.swift'
  s.dependency 'ExpoModulesCore'
end
