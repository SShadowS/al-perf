codeunit 50901 "Codeunit Local Get Test"
{
    procedure DoSomething()
    begin
        // A codeunit has no implicit Rec -- this calls the local procedure
        // `Get` below. Must NOT be collected as a record op.
        Get();
    end;

    procedure Get()
    begin
        Message('local Get, not a record op');
    end;
}
