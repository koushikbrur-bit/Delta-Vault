package com.deltavault.files;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DeltaFilesPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
