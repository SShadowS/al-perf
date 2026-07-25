codeunit 50970 "Object Level Globals"
{
    var
        GlobalTempBuffer: Record "Sales Line" temporary;
        GlobalRealLine: Record "Sales Line";
        GlobalNames: List of [Text];
        SalesLine: Codeunit "Temp Blob";

    procedure FillGlobalTempBuffer(var Source: Record "Sales Line")
    begin
        // The buffer's temp-ness is declared at OBJECT level. A member-local
        // scan cannot see it, so every Insert here reads as a SQL INSERT.
        if Source.FindSet() then
            repeat
                GlobalTempBuffer.Init();
                GlobalTempBuffer.Insert();
            until Source.Next() = 0;
    end;

    procedure InsertIntoGlobalRealRecord(var Source: Record "Sales Line")
    begin
        // Not temporary: these inserts really do hit the database.
        if Source.FindSet() then
            repeat
                GlobalRealLine.Init();
                GlobalRealLine.Insert();
            until Source.Next() = 0;
    end;

    procedure InsertIntoGlobalList(var Source: Record "Sales Line")
    begin
        // List of [Text].Insert() collides with the record-op method name.
        // Resolving the global's declared type is what excludes it.
        if Source.FindSet() then
            repeat
                GlobalNames.Insert(1, 'x');
            until Source.Next() = 0;
    end;

    procedure LocalShadowsGlobal(var Source: Record "Sales Line")
    var
        SalesLine: Record "Sales Line";
    begin
        // A local declaration wins over the object-level global of the SAME
        // name — here the global is a Codeunit, the local a real Record, and
        // the Insert must be reported.
        if Source.FindSet() then
            repeat
                SalesLine.Init();
                SalesLine.Insert();
            until Source.Next() = 0;
    end;
}
